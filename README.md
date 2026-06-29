# 📈 Monopoly Markets

A Bloomberg-style stock trading module for Monopoly. Players trade fictional stocks using their Monopoly money, adding a full financial layer to the board game.

> **Open source. No install. No server. Just open `index.html`.**

---

## Features

- **8 fictional stocks** — Boardwalk Properties (BPI), Community Chest Financial (CCF), Railroad Continental (RAIL), Utility Monopoly Corp (UTIL), Park Place Ventures (PPV), Mayfair Capital Group (MCG), Go Free Holdings (GOFH), Chance & Associates (CHCA)
- **Full trading** — Buy, Sell, Short Sell, Cover, Margin (2× leverage)
- **Dividend payouts** — paid each round automatically from holdings
- **Random news events** — 30+ Monopoly-themed headlines that move stocks each round
- **Live sparkline charts** — per-stock price history
- **Multi-player** — 2–8 players, each with their own portfolio view
- **Transaction log** — full history of all trades
- **Bloomberg terminal aesthetic** — dark, data-dense, monospace

---

## How to Play

1. Open `index.html` in any modern browser — no server needed.
2. Enter player names and their current **Monopoly balance** as starting capital.
3. Click **LAUNCH MARKET**.
4. Trade between Monopoly turns — buy and sell stocks, short positions, use margin.
5. Click **ADVANCE ROUND** after each Monopoly round to:
   - Trigger 1–2 random market news events
   - Update all stock prices
   - Automatically pay dividends into player balances
   - Charge 10% interest on any margin debt
6. Player balances flow directly back into your Monopoly game.

---

## Trading Guide

| Action | Description |
|--------|-------------|
| **BUY** | Purchase shares at the current price, deducted from Monopoly balance |
| **SELL** | Sell shares back to cash, added to Monopoly balance |
| **SHORT** | Borrow and sell shares now; profit if price falls |
| **COVER** | Buy back shorted shares to close the position |
| **Margin (2×)** | Double your buying power by borrowing — 10% interest charged each round |

**Dividends** are paid each round based on shares held × the stock's annual yield (prorated per round).

---

## Stocks Reference

| Ticker | Company | Sector | Div. Yield | Volatility |
|--------|---------|--------|-----------|-----------|
| BPI | Boardwalk Properties Inc | Real Estate | 3.0% | Medium |
| CCF | Community Chest Financial | Finance | 5.0% | Medium-High |
| RAIL | Railroad Continental | Transport | 2.0% | Low-Medium |
| UTIL | Utility Monopoly Corp | Utilities | 4.0% | Low |
| PPV | Park Place Ventures | Real Estate | 2.5% | Medium-High |
| MCG | Mayfair Capital Group | Finance | 1.5% | High |
| GOFH | Go Free Holdings | Leisure | 6.0% | High |
| CHCA | Chance & Associates | Diversified | 3.5% | Very High |

---

## Technical

- Single HTML file — no dependencies, no build step, no npm
- Pure vanilla JavaScript + React (inlined)
- Works offline after first load
- Tested in Chrome, Firefox, Safari, Edge

---

## License

MIT — see `LICENSE` file. Free to use, modify, and distribute.

---

## Contributing

Pull requests welcome! Ideas:
- Leaderboard / net worth ranking
- Round summary modal
- Export game state to JSON
- More stocks / news events
- Sound effects
