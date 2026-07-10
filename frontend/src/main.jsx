import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = 'http://127.0.0.1:8000';

const SPORTS = [
  { key: 'baseball_mlb', label: 'MLB' },
  { key: 'basketball_nba', label: 'NBA' },
  { key: 'americanfootball_nfl', label: 'NFL' },
  { key: 'icehockey_nhl', label: 'NHL' },
  { key: 'soccer_usa_mls', label: 'MLS' },
  { key: 'tennis_atp_wimbledon', label: 'ATP Wimbledon' },
  { key: 'tennis_wta_wimbledon', label: 'WTA Wimbledon' },
];

function App() {
  const [bankroll, setBankroll] = useState(1500);
  const [oddsA, setOddsA] = useState(2.18);
  const [oddsB, setOddsB] = useState(2.02);
  const [result, setResult] = useState(null);

  const [opportunities, setOpportunities] = useState([]);
  const [gamesChecked, setGamesChecked] = useState(0);
  const [sportsScanned, setSportsScanned] = useState(0);
  const [minimumRoi, setMinimumRoi] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [error, setError] = useState('');

  const implied = useMemo(() => {
    const a = Number(oddsA);
    const b = Number(oddsB);

    if (a <= 1 || b <= 1) {
      return null;
    }

    return (1 / a + 1 / b) * 100;
  }, [oddsA, oddsB]);

  async function loadLiveOpportunities() {
    setLoading(true);
    setError('');
    setHasScanned(false);

    try {
      const requests = SPORTS.map(async (sport) => {
        const response = await fetch(
          `${API}/live-opportunities?sport=${sport.key}&minimum_roi=${minimumRoi}`
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`${sport.label}: ${data.detail || 'Could not load odds.'}`);
        }

        return {
          sportLabel: sport.label,
          gamesChecked: data.games_checked || 0,
          opportunities: (data.opportunities || []).map((item) => ({
            ...item,
            sport_label: sport.label,
          })),
        };
      });

      const settled = await Promise.allSettled(requests);
      const successful = settled
        .filter((item) => item.status === 'fulfilled')
        .map((item) => item.value);

      const failures = settled
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason?.message)
        .filter(Boolean);

      const allOpportunities = successful
        .flatMap((item) => item.opportunities)
        .sort((a, b) => b.roi_percent - a.roi_percent);

      setSportsScanned(successful.length);
      setGamesChecked(
        successful.reduce((total, item) => total + item.gamesChecked, 0)
      );
      setOpportunities(allOpportunities);
      setHasScanned(true);

      if (failures.length > 0) {
        setError(`Some sports could not be scanned: ${failures.join(' | ')}`);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function calculate() {
    setError('');

    try {
      const response = await fetch(`${API}/calculate-arbitrage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bankroll: Number(bankroll),
          outcomes: [
            {
              sportsbook: 'Book A',
              selection: 'Team A',
              decimal_odds: Number(oddsA),
            },
            {
              sportsbook: 'Book B',
              selection: 'Team B',
              decimal_odds: Number(oddsB),
            },
          ],
        }),
      });

      const data = await response.json();
      setResult(data);
    } catch {
      setError('Could not connect to the backend at 127.0.0.1:8000.');
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">ARBING APP · PART 2</p>
          <h1>Sportsbook Arbitrage Dashboard</h1>
          <p className="subtitle">
            Scan major US sports and identify guaranteed-profit opportunities.
          </p>
        </div>

        <div className="status">Multi-Sport Scanner v0.3</div>
      </header>

      <section className="grid">
        <div className="card calculator">
          <h2>Arbitrage Calculator</h2>

          <label>Bankroll</label>
          <input
            type="number"
            value={bankroll}
            onChange={(event) => setBankroll(event.target.value)}
          />

          <div className="odds-grid">
            <div>
              <label>Book A decimal odds</label>
              <input
                type="number"
                step="0.01"
                value={oddsA}
                onChange={(event) => setOddsA(event.target.value)}
              />
            </div>

            <div>
              <label>Book B decimal odds</label>
              <input
                type="number"
                step="0.01"
                value={oddsB}
                onChange={(event) => setOddsB(event.target.value)}
              />
            </div>
          </div>

          <div className={`meter ${implied && implied < 100 ? 'good' : ''}`}>
            Combined implied probability:{' '}
            {implied ? implied.toFixed(2) : '—'}%
          </div>

          <button onClick={calculate}>Calculate stakes</button>

          {result && (
            <div className="result">
              <h3>
                {result.is_arbitrage ? 'Arbitrage found' : 'No arbitrage'}
              </h3>

              <div className="stats">
                <span>
                  Profit
                  <strong>${result.profit}</strong>
                </span>

                <span>
                  ROI
                  <strong>{result.roi_percent}%</strong>
                </span>

                <span>
                  Return
                  <strong>${result.guaranteed_return}</strong>
                </span>
              </div>

              {result.stakes?.map((item) => (
                <div
                  className="stake"
                  key={`${item.sportsbook}-${item.selection}`}
                >
                  <span>
                    {item.sportsbook} · {item.selection}
                  </span>

                  <strong>Bet ${item.stake}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="section-heading">
            <div>
              <h2>Live Multi-Sport Opportunities</h2>
              <span>
                {hasScanned
                  ? `${sportsScanned} sports · ${gamesChecked} games checked`
                  : 'Ready to scan'}
              </span>
            </div>
          </div>

          <label>Minimum ROI</label>
          <select
            value={minimumRoi}
            onChange={(event) => setMinimumRoi(Number(event.target.value))}
          >
            <option value={0}>0%+</option>
            <option value={1}>1%+</option>
            <option value={2}>2%+</option>
            <option value={3}>3%+</option>
            <option value={5}>5%+</option>
          </select>

          <button onClick={loadLiveOpportunities} disabled={loading}>
            {loading ? 'Scanning major sports...' : 'Scan All Major Sports'}
          </button>

          {error && <p className="error">{error}</p>}

          {hasScanned && opportunities.length === 0 && (
            <div className="empty-state">
              <h3>No arbitrage found right now</h3>
              <p>
                The scanner checked {gamesChecked} live or upcoming events
                across {sportsScanned} sports. Try again later when lines move.
              </p>
            </div>
          )}

          {opportunities.map((opportunity) => (
            <article
              className="opportunity"
              key={`${opportunity.sport_label}-${opportunity.event}-${opportunity.commence_time}`}
            >
              <div>
                <h3>{opportunity.event}</h3>
                <p>
                  {opportunity.sport_label} · {opportunity.market}
                </p>
              </div>

              <div className="roi">
                {opportunity.roi_percent.toFixed(2)}% ROI
              </div>

              {opportunity.outcomes.map((item) => (
                <div
                  className="line"
                  key={`${item.sportsbook}-${item.selection}`}
                >
                  <span>
                    {item.sportsbook} · {item.selection}
                  </span>

                  <strong>{item.decimal_odds.toFixed(2)}</strong>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
