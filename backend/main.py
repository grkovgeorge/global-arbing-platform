import asyncio
import os
from datetime import datetime, timezone
from typing import List

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Arbing App API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Same sport list the frontend scans on "Scan All Major Sports" / the live
# WebSocket feed, so both paths cover identical markets.
LIVE_SPORTS = [
    "baseball_mlb",
    "basketball_nba",
    "americanfootball_nfl",
    "icehockey_nhl",
    "soccer_usa_mls",
    "tennis_atp_wimbledon",
    "tennis_wta_wimbledon",
]

# Temporary fixed interval for Phase 1 WebSocket testing.
WS_UPDATE_INTERVAL_SECONDS = 10

QUOTA_EXHAUSTED_MESSAGE = "Odds API quota exhausted. Live scanning is temporarily unavailable."


def _is_quota_exhausted(response: httpx.Response) -> bool:
    try:
        return response.json().get("error_code") == "OUT_OF_USAGE_CREDITS"
    except ValueError:
        return False


# Shared in-memory cache populated by the single background fetch loop.
# All WebSocket clients read from this instead of each fetching independently.
_opportunities_cache = None
_cache_ready_event = asyncio.Event()
_background_task = None


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


async def fetch_live_opportunities(sport: str, minimum_roi: float = 0.0) -> dict:
    """Fetch odds for one sport and compute arbitrage opportunities.

    Shared by GET /live-opportunities and WS /ws/opportunities so both
    surfaces run the exact same calculation logic.
    """
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
        if _is_quota_exhausted(response):
            raise HTTPException(
                status_code=response.status_code,
                detail=QUOTA_EXHAUSTED_MESSAGE,
            )

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


@app.get("/live-opportunities")
async def live_opportunities(
    sport: str = "baseball_mlb",
    minimum_roi: float = 0.0,
):
    return await fetch_live_opportunities(sport, minimum_roi)


async def fetch_all_sports_opportunities(minimum_roi: float = 0.0) -> dict:
    """Fan out fetch_live_opportunities across every sport the dashboard
    tracks, merge the results, and sort by ROI. Used by the WebSocket feed
    so it mirrors what "Scan All Major Sports" does over REST today.
    """
    results = await asyncio.gather(
        *(fetch_live_opportunities(sport, minimum_roi) for sport in LIVE_SPORTS),
        return_exceptions=True,
    )

    all_opportunities = []
    games_checked_total = 0
    sports_scanned = 0
    quota_exhausted_logged = False

    for sport, result in zip(LIVE_SPORTS, results):
        if isinstance(result, BaseException):
            if isinstance(result, HTTPException) and result.detail == QUOTA_EXHAUSTED_MESSAGE:
                if not quota_exhausted_logged:
                    print(f"[ws] {QUOTA_EXHAUSTED_MESSAGE}")
                    quota_exhausted_logged = True
            else:
                print(f"[ws] failed to fetch {sport}: {result}")
            continue

        sports_scanned += 1
        games_checked_total += result["games_checked"]
        all_opportunities.extend(result["opportunities"])

    all_opportunities.sort(key=lambda item: item["roi_percent"], reverse=True)

    return {
        "opportunities": all_opportunities,
        "games_checked": games_checked_total,
        "sports_scanned": sports_scanned,
    }


async def _refresh_opportunities_cache():
    """The one and only place that actually calls the provider. Runs once
    for the whole process; every WS client just reads the cached result.
    """
    global _opportunities_cache

    while True:
        _opportunities_cache = await fetch_all_sports_opportunities()
        _cache_ready_event.set()
        await asyncio.sleep(WS_UPDATE_INTERVAL_SECONDS)


@app.on_event("startup")
async def _start_background_fetch_loop():
    global _background_task
    _background_task = asyncio.create_task(_refresh_opportunities_cache())


@app.websocket("/ws/opportunities")
async def ws_opportunities(websocket: WebSocket, minimum_roi: float = 0.0):
    await websocket.accept()

    await websocket.send_json(
        {
            "type": "connected",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": "WebSocket connection established.",
        }
    )

    try:
        await _cache_ready_event.wait()

        while True:
            snapshot = _opportunities_cache
            opportunities = [
                item for item in snapshot["opportunities"]
                if item["roi_percent"] >= minimum_roi
            ]

            await websocket.send_json(
                {
                    "type": "opportunities_update",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "opportunities": opportunities,
                    "opportunity_count": len(opportunities),
                    "games_checked": snapshot["games_checked"],
                    "sports_scanned": snapshot["sports_scanned"],
                }
            )

            await asyncio.sleep(WS_UPDATE_INTERVAL_SECONDS)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[ws] unexpected error, closing connection: {exc}")


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