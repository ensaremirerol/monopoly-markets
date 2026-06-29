// ============================================================================
// Monopoly Markets — UI component (DC framework)
// ----------------------------------------------------------------------------
// All game RULES live in the engine (window.GameEngine, see src/engine.js,
// inlined ahead of this script by build.js). This class is a thin shell: it
// holds React-style UI state, calls the engine for every mutation, and maps
// the result into the {{ bindings }} consumed by the markup. Keep logic out of
// here — if a rule needs changing, change the engine (and its tests) instead.
// ============================================================================

const G = '#3fb950';
const R = '#f85149';
const B = '#58a6ff';
const Y = '#e3b341';
const P = '#bc8cff';

const ROUND_MODES = [
  { m: 'none', label: 'Cents' },
  { m: 'integer', label: 'Whole $' },
  { m: 'five', label: 'Nearest $5' },
];

class Component extends DCLogic {
  state = {
    phase: 'setup',
    gameName: 'Friday Night',
    mode: 'integer',
    setupCount: 3,
    setupNames: Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`),
    players: [],
    stocks: [],
    round: 1,
    news: [],
    transactions: [],
    activePlayer: 0,
    tradePlayerIdx: 0,
    tradeStockId: 'BPI',
    tradeAction: 'buy',
    tradeQty: '',
    tradeMargin: false,
    toast: null,
  };

  eng() { return window.GameEngine; }
  engineState() {
    return {
      gameName: this.state.gameName, mode: this.state.mode, round: this.state.round,
      stocks: this.state.stocks, players: this.state.players,
      news: this.state.news, transactions: this.state.transactions,
    };
  }

  // ── Formatting (respects the chosen rounding mode) ──
  decimals() { return this.state.mode === 'none' ? 2 : 0; }
  num(n) { return Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: this.decimals(), maximumFractionDigits: this.decimals() }); }
  fmt(n) { return '$' + this.num(n); }                                   // inherently positive
  fmtS(n) { return ((n || 0) < 0 ? '-$' : '$') + this.num(n); }          // signed (net worth)
  fmtChg(n) { return ((n || 0) >= 0 ? '+$' : '-$') + this.num(n); }      // P&L with sign
  fmtPct(n) { n = n || 0; return (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%'; }
  clr(n) { return (n || 0) >= 0 ? G : R; }

  makeSparkline(history, up) {
    const w = 68, h = 22;
    const color = up ? G : R;
    if (!history || history.length < 2) {
      return React.createElement('svg', { width: w, height: h },
        React.createElement('line', { x1: 0, y1: h / 2, x2: w, y2: h / 2, stroke: '#30363d', strokeWidth: 1 }));
    }
    const min = Math.min(...history);
    const max = Math.max(...history);
    const rng = max - min || 1;
    const pts = history.map((v, i) => {
      const x = (i / (history.length - 1)) * (w - 2) + 1;
      const y = (h - 3) - ((v - min) / rng) * (h - 5) + 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return React.createElement('svg', { width: w, height: h, style: { display: 'block' } },
      React.createElement('polyline', { points: pts, fill: 'none', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
  }

  // ── Setup actions ──
  setGameName(v) { this.setState({ gameName: v }); }
  setMode(m) { this.setState({ mode: m }); }
  setSetupCount(n) { this.setState({ setupCount: n }); }
  setSetupName(i, v) {
    const names = this.state.setupNames.map((n, j) => (j === i ? v : n));
    this.setState({ setupNames: names });
  }

  launchMarket() {
    const E = this.eng();
    const { setupCount, setupNames, mode } = this.state;
    const names = setupNames.slice(0, setupCount).map((n, i) => n || `Player ${i + 1}`);
    const stocks = E.createStocks(mode);
    const players = names.map(E.createPlayer);
    this.setState({ phase: 'market', stocks, players, round: 1, news: [], transactions: [], activePlayer: 0, tradePlayerIdx: 0, tradeStockId: stocks[0].id });
  }

  // ── Save / load (#1) ──
  onSave() {
    const E = this.eng();
    const blob = new Blob([E.serialize(this.engineState())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = E.saveFilename(this.state.gameName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast('Saved ' + a.download, 'success');
  }
  onLoadFile(e) {
    const file = e.target && e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const st = this.eng().deserialize(reader.result);
        this.setState({
          phase: 'market', gameName: st.gameName, mode: st.mode, round: st.round,
          stocks: st.stocks, players: st.players, news: st.news, transactions: st.transactions,
          activePlayer: 0, tradePlayerIdx: 0, tradeStockId: st.stocks[0] ? st.stocks[0].id : 'BPI',
        });
        this.showToast('Loaded ' + st.gameName, 'success');
      } catch (err) {
        this.showToast('Could not read that save file', 'error');
      }
    };
    reader.readAsText(file);
  }

  // ── Market actions ──
  selectPlayer(i) { this.setState({ activePlayer: i }); }
  showToast(msg, type = 'info') {
    this.setState({ toast: { msg, type } });
    setTimeout(() => this.setState({ toast: null }), 3500);
  }

  executeTrade() {
    const E = this.eng();
    const { tradePlayerIdx, tradeStockId, tradeAction, tradeQty, tradeMargin } = this.state;
    const res = E.applyTrade(this.engineState(), { playerIdx: tradePlayerIdx, stockId: tradeStockId, action: tradeAction, qty: tradeQty, margin: tradeMargin });
    if (res.error) { this.showToast(res.error, 'error'); return; }
    const stock = E.findStock(this.state.stocks, tradeStockId);
    this.setState({ players: res.state.players, transactions: res.state.transactions, tradeQty: '' });
    this.showToast(`${tradeAction.toUpperCase()} ${parseInt(tradeQty, 10)}× ${tradeStockId} @ ${this.fmt(stock.price)}`, 'success');
  }

  repayLoan() {
    const E = this.eng();
    const idx = this.state.activePlayer;
    const p = this.state.players[idx];
    if (!p || !p.loan) { this.showToast('No loan to repay', 'error'); return; }
    const res = E.applyTrade(this.engineState(), { playerIdx: idx, stockId: null, action: 'repay', qty: p.loan });
    if (res.error) { this.showToast(res.error, 'error'); return; }
    this.setState({ players: res.state.players, transactions: res.state.transactions });
    this.showToast(`${p.name} repaid their loan`, 'success');
  }

  advanceRound() {
    const E = this.eng();
    const res = E.advanceRound(this.engineState());
    this.setState({ stocks: res.state.stocks, players: res.state.players, round: res.state.round, news: res.state.news });
    let msg = `Round ${res.state.round} — ${res.events.length} market event${res.events.length > 1 ? 's' : ''}`;
    if (res.liquidations.length) msg += ` · ${res.liquidations.length} margin call${res.liquidations.length > 1 ? 's' : ''}`;
    this.showToast(msg, res.liquidations.length ? 'error' : 'success');
  }

  renderVals() {
    const E = this.eng();
    const s = this.state;
    const { phase, stocks, players, round, news, transactions, activePlayer, tradePlayerIdx, tradeStockId, tradeAction, tradeQty, tradeMargin, toast } = s;

    // ── Setup ──
    const roundBtns = ROUND_MODES.map(rm => ({
      label: rm.label, onClick: () => this.setMode(rm.m),
      bg: rm.m === s.mode ? '#238636' : '#161b22',
      color: rm.m === s.mode ? '#fff' : '#8b949e',
      border: rm.m === s.mode ? '#2ea043' : '#30363d',
    }));
    const setupCountBtns = [2, 3, 4, 5, 6, 7, 8].map(n => ({
      n, onClick: () => this.setSetupCount(n),
      bg: n === s.setupCount ? '#238636' : '#161b22',
      color: n === s.setupCount ? '#fff' : '#8b949e',
      border: n === s.setupCount ? '#2ea043' : '#30363d',
    }));
    const setupRows = s.setupNames.slice(0, s.setupCount).map((name, i) => ({
      name, namePlaceholder: `Player ${i + 1}`,
      onNameChange: e => this.setSetupName(i, e.target.value),
    }));

    // ── Market: stocks ──
    const stockRows = stocks.map(st => {
      const chg = st.price - st.prevPrice;
      const chgPct = chg / (st.prevPrice || 1);
      const up = chg >= 0;
      return {
        id: st.id, name: st.name,
        priceStr: this.fmt(st.price),
        chgPctStr: this.fmtPct(chgPct),
        chgColor: up ? G : R,
        yieldStr: (st.dividendYield * 100).toFixed(1) + '%',
        yieldBarWidth: Math.round(st.dividendYield * 1200),
        sparkline: this.makeSparkline(st.history, up),
        onClick: () => this.setState({ tradeStockId: st.id }),
        bg: st.id === tradeStockId ? '#1c2128' : 'transparent',
        borderColor: st.id === tradeStockId ? '#30363d' : 'transparent',
      };
    });
    const tickerItems = stocks.map(st => {
      const chg = st.price - st.prevPrice;
      const up = chg >= 0;
      return { id: st.id, priceStr: this.fmt(st.price), pctStr: this.fmtPct(chg / (st.prevPrice || 1)), color: up ? G : R, arrow: up ? '▲' : '▼' };
    });

    // ── Player tabs (flag a margin call) ──
    const playerTabs = players.map((p, i) => ({
      name: p.name, onClick: () => this.selectPlayer(i),
      bg: i === activePlayer ? '#0d1117' : 'transparent',
      color: i === activePlayer ? '#e6edf3' : '#8b949e',
      accentBorder: i === activePlayer ? B : 'transparent',
      flag: E.marginStatus(p, stocks).call ? ' ⚠' : '',
    }));

    // ── Leaderboard (#5) ──
    const lbRows = E.leaderboard(s).map((row, i) => ({
      rank: i + 1, name: row.name,
      worthStr: this.fmtS(row.netWorth), worthColor: this.clr(row.netWorth),
      bg: row.idx === activePlayer ? '#161b22' : 'transparent',
      border: row.idx === activePlayer ? '#30363d' : '#21262d',
    }));

    // ── Active player ──
    const ap = players[activePlayer];
    let portRows = [], shortRows = [], portValue = 0, nworth = 0, ms = { loan: 0, collateral: 0, ratio: 0, call: false };
    if (ap) {
      portValue = E.longValue(ap, stocks);
      nworth = E.netWorth(ap, stocks);
      ms = E.marginStatus(ap, stocks);
      portRows = Object.keys(ap.portfolio).map(id => {
        const h = ap.portfolio[id];
        const st = E.findStock(stocks, id);
        if (!st || h.shares <= 0) return null;
        const pnl = h.shares * (st.price - h.avgCost);
        return { id, shares: h.shares, avgStr: this.fmt(h.avgCost), priceStr: this.fmt(st.price), valueStr: this.fmt(h.shares * st.price), pnlStr: this.fmtChg(pnl), pnlColor: this.clr(pnl) };
      }).filter(Boolean);
      shortRows = Object.keys(ap.shorts).map(id => {
        const sh = ap.shorts[id];
        const st = E.findStock(stocks, id);
        if (!st || sh.shares <= 0) return null;
        const pnl = sh.shares * (sh.openPrice - st.price);
        return { id, shares: sh.shares, openStr: this.fmt(sh.openPrice), currStr: this.fmt(st.price), coverStr: this.fmt(sh.shares * st.price), pnlStr: this.fmtChg(pnl), pnlColor: this.clr(pnl) };
      }).filter(Boolean);
    }

    // ── Trade panel ──
    const tradeStock = E.findStock(stocks, tradeStockId);
    const qty = parseInt(tradeQty, 10) || 0;
    const estTotalNum = qty * (tradeStock ? tradeStock.price : 0);
    const tradeActions = ['buy', 'sell', 'short', 'cover'].map(a => {
      const cols = { buy: [G, '#1a4329'], sell: [R, '#3d1a1a'], short: [B, '#1a1a3d'], cover: [P, '#2a1a3d'] };
      const isActive = a === tradeAction;
      return { label: a.toUpperCase(), onClick: () => this.setState({ tradeAction: a }), bg: isActive ? cols[a][1] : '#0d1117', color: isActive ? cols[a][0] : '#484f58', border: isActive ? cols[a][0] : '#21262d' };
    });

    // ── News & transactions ──
    const newsItems = news.map((n, i) => ({
      key: i, roundStr: `R${n.round}`, headline: n.headline, stockId: n.stockId,
      impactStr: this.fmtPct(n.impact), color: n.positive ? G : R, arrow: n.positive ? '▲' : '▼',
    }));
    const txnRows = transactions.slice(0, 14).map((t, i) => ({
      key: i, roundStr: `R${t.round}`, player: t.player, action: t.action, stock: t.stock, qty: t.qty,
      priceStr: t.price == null ? '—' : this.fmt(t.price), totalStr: this.fmtChg(t.total), totalColor: this.clr(t.total),
      actionColor: { BUY: G, SELL: R, SHORT: B, COVER: P, REPAY: Y }[t.action] || '#8b949e',
    }));

    const toastBg = toast ? (toast.type === 'error' ? R : toast.type === 'success' ? G : B) : G;
    const ratioPctStr = ms.collateral > 0 ? (ms.ratio * 100).toFixed(0) + '% of collateral · call at 80%' : 'no collateral';

    // Tell the player exactly what to do with their tabletop cash for this order.
    let estLabel;
    if (tradeAction === 'buy' && tradeMargin) estLabel = 'Add to loan';     // borrowed — no cash now
    else if (tradeAction === 'sell' || tradeAction === 'short') estLabel = 'Collect (cash)';
    else estLabel = 'Pay (cash)';                                            // cash buy or cover

    return {
      isSetup: phase === 'setup',
      isMarket: phase === 'market',
      gameName: s.gameName,
      onGameNameChange: e => this.setGameName(e.target.value),
      roundBtns, setupCountBtns, setupRows,
      onLaunch: () => this.launchMarket(),
      onLoadFile: e => this.onLoadFile(e),
      onSave: () => this.onSave(),
      round, playerTabs, stockRows, tickerItems, lbRows,
      apName: ap ? ap.name : '',
      apLiquidated: ap ? !!ap.liquidatedThisRound : false,
      apRealized: ap ? this.fmtChg(ap.realized) : '+$0',
      apRealizedColor: ap ? this.clr(ap.realized) : '#e6edf3',
      apPortValue: this.fmt(portValue),
      apLoan: this.fmt(ms.loan),
      apTotal: this.fmtS(nworth),
      apTotalColor: this.clr(nworth),
      apHasLoan: ms.loan > 0,
      apCollateral: this.fmt(ms.collateral),
      apMarginRatioStr: ratioPctStr,
      apMarginLabel: ms.call ? '⚠ MARGIN CALL — liquidates on next advance' : 'Loan outstanding',
      apMarginBorder: ms.call ? R : Y,
      apMarginBg: ms.call ? '#2a1215' : '#1a1007',
      onRepay: () => this.repayLoan(),
      portRows, shortRows,
      hasPortRows: portRows.length > 0,
      hasShortRows: shortRows.length > 0,
      emptyPortfolio: portRows.length === 0 && shortRows.length === 0,
      tradePlayerOptions: players.map((p, i) => ({ label: p.name, value: i })),
      tradeStockOptions: stocks.map(st => ({ label: `${st.id} — ${this.fmt(st.price)}`, value: st.id })),
      tradePlayerIdx, tradeStockId, tradeActions, tradeQty, tradeMargin,
      estLabel,
      estTotal: qty > 0 ? this.fmt(estTotalNum) : '—',
      onTradePlayerChange: e => this.setState({ tradePlayerIdx: parseInt(e.target.value, 10) }),
      onTradeStockChange: e => this.setState({ tradeStockId: e.target.value }),
      onTradeQtyChange: e => this.setState({ tradeQty: e.target.value }),
      onToggleMargin: () => this.setState({ tradeMargin: !tradeMargin }),
      onExecute: () => this.executeTrade(),
      onAdvance: () => this.advanceRound(),
      newsItems, hasNews: newsItems.length > 0, noNews: newsItems.length === 0,
      txnRows, hasTxns: txnRows.length > 0, noTxns: txnRows.length === 0,
      hasToast: !!toast,
      toastMsg: toast ? toast.msg : '',
      toastBg,
    };
  }
}
