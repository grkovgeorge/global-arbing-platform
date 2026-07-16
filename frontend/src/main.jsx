import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = 'http://127.0.0.1:8000';
const WS_URL = 'ws://127.0.0.1:8000/ws/opportunities';
const WS_RECONNECT_DELAY_MS = 3000;

const SPORTS = [
  { key: 'baseball_mlb', label: 'MLB' },
  { key: 'basketball_nba', label: 'NBA' },
  { key: 'americanfootball_nfl', label: 'NFL' },
  { key: 'icehockey_nhl', label: 'NHL' },
  { key: 'soccer_usa_mls', label: 'MLS' },
  { key: 'tennis_atp_wimbledon', label: 'ATP Wimbledon' },
  { key: 'tennis_wta_wimbledon', label: 'WTA Wimbledon' },
];

const SPORT_LABELS = SPORTS.reduce((map, sport) => {
  map[sport.key] = sport.label;
  return map;
}, {});

const SPORTSBOOK_FALLBACK_URLS = {
  DraftKings: "https://sportsbook.draftkings.com/",
  FanDuel: "https://sportsbook.fanduel.com/",
  BetMGM: "https://sports.betmgm.com/",
  Caesars: "https://www.caesars.com/sportsbook-and-casino",
};

function formatCommenceTime(iso) {
  const date = iso ? new Date(iso) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return 'Start time TBD';
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const NOTIFY_ROI_THRESHOLD = 2;

function getOpportunityKey(opportunity) {
  return `${opportunity.sport}-${opportunity.event}-${opportunity.commence_time}`;
}

function notificationsSupported() {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

function getRoiTier(roiPercent) {
  if (roiPercent >= 2) return 'green';
  if (roiPercent >= 1) return 'yellow';
  return 'red';
}

function OpportunityCard({ opportunity }) {
  const [bankroll, setBankroll] = useState(100);

  const totalInverseOdds = opportunity.outcomes.reduce(
    (total, item) => total + 1 / item.decimal_odds,
    0
  );

  const guaranteedReturn = Number(bankroll) / totalInverseOdds;
  const profit = guaranteedReturn - Number(bankroll);

  const outcomesWithStakes = opportunity.outcomes.map((item) => ({
    ...item,
    stake: guaranteedReturn / item.decimal_odds,
  }));

  const commenceDate = opportunity.commence_time ? new Date(opportunity.commence_time) : null;
  const isLive = Boolean(commenceDate && !Number.isNaN(commenceDate.getTime()) && commenceDate.getTime() <= Date.now());
  const bookNames = opportunity.outcomes.map((item) => item.sportsbook).join(', ');

  return (
    <article className="opportunity">
      <div>
        <h3>{opportunity.event}</h3>
        <p>
          {opportunity.sport_label} · {opportunity.market}
        </p>
        <p className="game-time">
          {formatCommenceTime(opportunity.commence_time)}{' '}
          <span className={`badge badge-${isLive ? 'live' : 'upcoming'}`}>
            {isLive ? 'LIVE' : 'UPCOMING'}
          </span>
        </p>
        <p className="books-used">Books: {bookNames}</p>
      </div>

      <div className={`roi roi-${getRoiTier(opportunity.roi_percent)}`}>
        {opportunity.roi_percent.toFixed(2)}% ROI
      </div>

      <div className="stake-calculator">
        <label>Bankroll</label>
        <input
          type="number"
          value={bankroll}
          onChange={(event) => setBankroll(event.target.value)}
        />
      </div>

      <div className="arb-summary">
        <p>Bankroll: <strong>${Number(bankroll).toFixed(2)}</strong></p>
        <p>Guaranteed Return: <strong>${guaranteedReturn.toFixed(2)}</strong></p>
        <p>Guaranteed Profit: <strong>${profit.toFixed(2)}</strong></p>
      </div>

      {outcomesWithStakes.map((item) => {
        // item.deep_link_url would come from the opportunity data itself (e.g. a
        // future backend/provider field). Until that exists, fall back to the
        // known static sportsbook URLs, then to a disabled placeholder button.
        const linkUrl = item.deep_link_url || SPORTSBOOK_FALLBACK_URLS[item.sportsbook] || null;

        return (
          <div className="line" key={`${item.sportsbook}-${item.selection}`}>
            <button
              type="button"
              className="sportsbook-btn"
              disabled={!linkUrl}
              title={linkUrl ? `Open ${item.sportsbook} in a new tab` : `${item.sportsbook} link coming soon`}
              onClick={() => {
                if (linkUrl) window.open(linkUrl, '_blank', 'noopener,noreferrer');
              }}
            >
              {item.sportsbook} · {item.selection}
            </button>

            <div style={{ textAlign: "right" }}>
              <strong>{item.decimal_odds.toFixed(2)}</strong>
              <br />
              <small>Bet ${item.stake.toFixed(2)}</small>
            </div>
          </div>
        );
      })}
    </article>
  );
}

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
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [wsStatus, setWsStatus] = useState('disconnected');
  const notifiedEventsRef = useRef(new Set());
  const [filterTeam, setFilterTeam] = useState('');
  const [filterSport, setFilterSport] = useState('');
  const [filterSportsbook, setFilterSportsbook] = useState('');
  const [filterMinRoi, setFilterMinRoi] = useState('');

  const filteredOpportunities = useMemo(() => {
    const teamQuery = filterTeam.trim().toLowerCase();
    const bookQuery = filterSportsbook.trim().toLowerCase();
    const minRoi = filterMinRoi === '' ? null : Number(filterMinRoi);

    return opportunities.filter((opportunity) => {
      if (
        teamQuery &&
        !opportunity.event.toLowerCase().includes(teamQuery) &&
        !opportunity.outcomes.some((item) => item.selection.toLowerCase().includes(teamQuery))
      ) {
        return false;
      }

      if (filterSport && opportunity.sport !== filterSport) {
        return false;
      }

      if (
        bookQuery &&
        !opportunity.outcomes.some((item) => item.sportsbook.toLowerCase().includes(bookQuery))
      ) {
        return false;
      }

      if (minRoi !== null && !Number.isNaN(minRoi) && opportunity.roi_percent < minRoi) {
        return false;
      }

      return true;
    });
  }, [opportunities, filterTeam, filterSport, filterSportsbook, filterMinRoi]);
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
  
useEffect(() => {
  if (!autoRefresh) {
    setWsStatus('disconnected');
    return;
  }

  let isActive = true;
  let socket = null;
  let reconnectTimer = null;

  function connect() {
    if (!isActive) return;

    setWsStatus('connecting');
    socket = new WebSocket(`${WS_URL}?minimum_roi=${minimumRoi}`);

    socket.onopen = () => {
      if (isActive) setWsStatus('live');
    };

    socket.onmessage = (event) => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type !== 'opportunities_update') return;

      const withLabels = (data.opportunities || []).map((item) => ({
        ...item,
        sport_label: SPORT_LABELS[item.sport] || item.sport,
      }));

      const sorted = withLabels.sort((a, b) => b.roi_percent - a.roi_percent);

      if (notificationsSupported() && Notification.permission === 'granted') {
        sorted.forEach((opportunity) => {
          if (opportunity.roi_percent < NOTIFY_ROI_THRESHOLD) return;

          const key = getOpportunityKey(opportunity);
          if (notifiedEventsRef.current.has(key)) return;

          notifiedEventsRef.current.add(key);

          const bookNames = opportunity.outcomes.map((item) => item.sportsbook).join(', ');

          new Notification('Arbitrage opportunity found', {
            body: `${opportunity.event}\n${opportunity.roi_percent.toFixed(2)}% ROI · ${bookNames}`,
          });
        });
      }

      setOpportunities(sorted);
      setGamesChecked(data.games_checked ?? 0);
      setSportsScanned(data.sports_scanned ?? 0);
      setHasScanned(true);
    };

    socket.onclose = () => {
      if (!isActive) return;
      setWsStatus('disconnected');
      reconnectTimer = setTimeout(connect, WS_RECONNECT_DELAY_MS);
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  connect();

  return () => {
    isActive = false;
    clearTimeout(reconnectTimer);

    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}, [autoRefresh, minimumRoi]);

  function handleAutoRefreshToggle(enabled) {
    setAutoRefresh(enabled);

    if (enabled && notificationsSupported() && Notification.permission === 'default') {
      Notification.requestPermission();
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

<div style={{ marginTop: "15px", marginBottom: "15px" }}>
  <label>
    <input
      type="checkbox"
      checked={autoRefresh}
      onChange={(e) => handleAutoRefreshToggle(e.target.checked)}
    />
    {' '}Auto Refresh (live)
  </label>

  {autoRefresh && (
    <span className={`ws-status ws-status-${wsStatus}`} style={{ marginLeft: "10px" }}>
      {wsStatus === 'connecting' && 'Connecting…'}
      {wsStatus === 'live' && 'Live'}
      {wsStatus === 'disconnected' && 'Disconnected — retrying…'}
    </span>
  )}
</div>
          <button onClick={loadLiveOpportunities} disabled={loading}>
            {loading ? 'Scanning major sports...' : 'Scan All Major Sports'}
          </button>

          {error && <p className="error">{error}</p>}

          <div className="filter-bar">
            <input
              type="text"
              placeholder="Search team..."
              value={filterTeam}
              onChange={(event) => setFilterTeam(event.target.value)}
            />

            <select
              value={filterSport}
              onChange={(event) => setFilterSport(event.target.value)}
            >
              <option value="">All sports</option>
              {SPORTS.map((sport) => (
                <option key={sport.key} value={sport.key}>
                  {sport.label}
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Search sportsbook..."
              value={filterSportsbook}
              onChange={(event) => setFilterSportsbook(event.target.value)}
            />

            <input
              type="number"
              placeholder="Min ROI %"
              value={filterMinRoi}
              onChange={(event) => setFilterMinRoi(event.target.value)}
            />
          </div>

          {hasScanned && opportunities.length === 0 && (
            <div className="empty-state">
              <h3>No arbitrage found right now</h3>
              <p>
                The scanner checked {gamesChecked} live or upcoming events
                across {sportsScanned} sports. Try again later when lines move.
              </p>
            </div>
          )}

          {opportunities.length > 0 && filteredOpportunities.length === 0 && (
            <div className="empty-state">
              <h3>No opportunities match your filters</h3>
              <p>Try clearing the team, sport, sportsbook, or minimum ROI filters.</p>
            </div>
          )}

          {filteredOpportunities.map((opportunity) => (
            <OpportunityCard
              key={`${opportunity.sport_label}-${opportunity.event}-${opportunity.commence_time}`}
              opportunity={opportunity}
            />
          ))}
</div>
</section>
</main>
);
}

createRoot(document.getElementById('root')).render(<App />);
