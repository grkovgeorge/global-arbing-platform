import os
from typing import List

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Arbing App API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Outcome(BaseModel):
    sportsbook: str
    selection: str
    decimal_odds: float


class ArbRequest(BaseModel):
    bankroll: float
    outcomes: List[Outcome]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/sample-opportunities")
def sample_opportunities():
    return [
        {
            "event": "Chicago Bulls vs Milwaukee Bucks",
            "market": "Moneyline",
            "outcomes": [
                {
                    "sportsbook": "Book A",
                    "selection": "Chicago Bulls",
                    "decimal_odds": 2.18,
                },
                {
                    "sportsbook": "Book B",
                    "selection": "Milwaukee Bucks",
                    "decimal_odds": 2.02,
                },
            ],
        },
        {
            "event": "Detroit Lions vs Green Bay Packers",
            "market": "Moneyline",
            "outcomes": [
                {
                    "sportsbook": "Book C",
                    "selection": "Detroit Lions",
                    "decimal_odds": 2.12,
                },
                {
                    "sportsbook": "Book D",
                    "selection": "Green Bay Packers",
                    "decimal_odds": 2.08,
                },
            ],
        },
    ]


@app.get("/live-opportunities")
async def live_opportunities(
    sport: str = "baseball_mlb",
    minimum_roi: float = 0.0,
):
    api_key = os.getenv("ODDS_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ODDS_API_KEY is missing from the .env file.",
        )

    url = f"https://api.the-odds-api.com/v4/sports/{sport}/odds"

    params = {
        "apiKey": api_key,
        "regions": "us",
        "markets": "h2h",
        "oddsFormat": "decimal",
        "dateFormat": "iso",
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(url, params=params)

    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"Odds provider error: {response.text}",
        )

    games = response.json()
    opportunities = []

    for game in games:
        best_outcomes = {}

        for bookmaker in game.get("bookmakers", []):
            sportsbook_name = bookmaker.get("title", "Unknown sportsbook")

            for market in bookmaker.get("markets", []):
                if market.get("key") != "h2h":
                    continue

                for outcome in market.get("outcomes", []):
                    selection = outcome.get("name")
                    price = outcome.get("price")

                    if not selection or not isinstance(price, (int, float)):
                        continue

                    current_best = best_outcomes.get(selection)

                    if current_best is None or price > current_best["decimal_odds"]:
                        best_outcomes[selection] = {
                            "sportsbook": sportsbook_name,
                            "selection": selection,
                            "decimal_odds": float(price),
                        }

        outcomes = list(best_outcomes.values())

        if len(outcomes) < 2:
            continue

        implied_total = sum(
            1 / outcome["decimal_odds"]
            for outcome in outcomes
        )

        roi_percent = ((1 / implied_total) - 1) * 100
        is_arbitrage = implied_total < 1

        if is_arbitrage and roi_percent >= minimum_roi:
            opportunities.append(
                {
                    "event": (
                        f"{game.get('away_team', 'Away')} vs "
                        f"{game.get('home_team', 'Home')}"
                    ),
                    "sport": sport,
                    "commence_time": game.get("commence_time"),
                    "market": "Moneyline",
                    "implied_probability_total": round(
                        implied_total * 100,
                        3,
                    ),
                    "roi_percent": round(roi_percent, 3),
                    "outcomes": outcomes,
                }
            )

    opportunities.sort(
        key=lambda item: item["roi_percent"],
        reverse=True,
    )

    return {
        "sport": sport,
        "games_checked": len(games),
        "opportunities_found": len(opportunities),
        "opportunities": opportunities,
    }


@app.post("/calculate-arbitrage")
def calculate_arbitrage(payload: ArbRequest):
    if payload.bankroll <= 0:
        return {
            "is_arbitrage": False,
            "error": "Bankroll must be greater than zero.",
        }

    if len(payload.outcomes) < 2:
        return {
            "is_arbitrage": False,
            "error": "At least two outcomes are required.",
        }

    if any(item.decimal_odds <= 1 for item in payload.outcomes):
        return {
            "is_arbitrage": False,
            "error": "All decimal odds must be greater than 1.00.",
        }

    implied_total = sum(
        1 / item.decimal_odds
        for item in payload.outcomes
    )

    is_arbitrage = implied_total < 1
    guaranteed_return = payload.bankroll / implied_total
    stakes = []

    for item in payload.outcomes:
        stake = payload.bankroll * (
            (1 / item.decimal_odds) / implied_total
        )

        stakes.append(
            {
                "sportsbook": item.sportsbook,
                "selection": item.selection,
                "decimal_odds": item.decimal_odds,
                "stake": round(stake, 2),
                "payout": round(stake * item.decimal_odds, 2),
            }
        )

    profit = guaranteed_return - payload.bankroll

    return {
        "is_arbitrage": is_arbitrage,
        "implied_probability_total": round(
            implied_total * 100,
            3,
        ),
        "profit": round(profit, 2),
        "roi_percent": round(
            (profit / payload.bankroll) * 100,
            3,
        ),
        "guaranteed_return": round(
            guaranteed_return,
            2,
        ),
        "stakes": stakes,
    }