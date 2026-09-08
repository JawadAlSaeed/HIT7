<div align="center">
  <img src="public/images/hit7-logo.png" alt="HIT 7 Logo" width="200"/>
  <p>A fast-paced card game of risk and strategy!</p>
</div>

## 🎮 About The Game
HIT 7 is an exciting multiplayer card game that combines luck, strategy, and risk management. Players take turns drawing cards to build their hands while avoiding duplicates. Use special cards strategically, and be the first to reach 200 points to win!

## ⚙️ Game Setup

The host picks all three of these in the waiting room, before the first card is dealt.

### Deck

| Deck | Cards | What's in it |
|---|---|---|
| **Normal** | 94 | The Flip 7 deck: numbers, Freeze, Draw Three, Second Chance and the plus cards. |
| **Extreme** | 108 | Everything below. Adds Remove, Steal, Swap, Select, the minus cards and Halve. |

### Target score

`100`, `150`, `200` (default) or `300`.

### If somebody drops mid-game
The round pauses so nobody loses their cards, and the host gets three choices:

- **Wait** — do nothing. They can rejoin with their name and the game code.
- **Let a bot take over** — a bot inherits the seat, keeping their cards, their score
  and their turn. The round carries straight on. They cannot rejoin that seat afterwards.
- **Remove & restart round** — frees the seat, but replays the round from the start.
  Scores from earlier rounds are kept.

### Bots

`0` to `5`. Bots take real seats at the table, so people plus bots have to fit in six.
Since a game needs two players, one human and one bot is a valid game - which is how
you practise on your own.

They are marked 🤖 in the waiting room and on the board, so nobody has to guess who is
real. Each one gets a personality, and they are dealt out so a table of bots is a table
of different players:

| Bot | How it plays |
|---|---|
| **Cautious** | Banks early, rarely busts. |
| **Reckless** | Chases the seven-card bonus off a cliff. |
| **Streaky** | Safe while it is ahead, all in the moment it falls behind. |
| **Copycat** | Reads the room and matches it, which is a fine instinct and a terrible plan. |

None of them plays the odds perfectly, on purpose. A bot works out its chances from the
deck for the mode and the cards it can actually see - never the shuffled pile - and then
every so often does the opposite of what it worked out. Each also drifts a little from
round to round, so the same bot never plays two rounds the same way.

## 🃏 Game Components

The full **Extreme** deck. **Normal** leaves out every card marked ⚡ below.

### Regular Cards (79 cards)
- One '0' card
- One '1' card
- Two '2' cards
- Three '3' cards
- And so on until twelve '12' cards

### Special Cards (29 cards)

#### Power Cards
- 🛡️ Second Chance (3) - Protects you from busting on a duplicate
- ❄️ Freeze (3) - Skip another player's turn
- 🎯 Draw Three (3) - Force a player to draw three cards in succession
- 🗑️ Remove Card (3) ⚡ - Remove any card from any player's collection
- 🥷 Steal Card (2) ⚡ - Steal a card from another player
- ⇄️ Swap Card (2) ⚡ - Swap two cards between different players (including yourself)
- 🃏 Select Card (1) ⚡ - Select any card from the Deck

#### Point Modifier Cards
- ➕ Adders (5):
  - 2+, 4+, 6+, 8+, 10+
- ➖ Minus (5) ⚡:
  - 2-, 4-, 6-, 8-, 10-
- ✖️ Multiplier (1):
  - 2x
- ➗ Divide (1) ⚡:
  - 2÷ (Halves your score)

## 🎲 Gameplay Rules

### The deck
One deck lasts the whole game. It is **not** re-dealt between rounds - the cards from
everyone's hands go onto the discard pile and the draw pile just keeps going down.

When the draw pile actually runs out, the discard pile is shuffled and becomes the new
draw pile. Whatever is in somebody's hand at that moment stays in their hand, so it is
not part of what gets shuffled - which is what stops the same card ever being in play
twice. Exactly like real cards on a real table.

### Basic Rules
1. Players take turns drawing cards
2. Maximum of 7 regular cards per player
3. Drawing a duplicate number = BUST (unless you have 🛡️)
4. Players can "STAND" to bank their points
5. Special cards don't count toward the 7-card limit

### 💯 Scoring System
- Base points: Sum of all unique regular cards
- Modifiers:
  - Add cards (+): Add their value to your score
  - Minus cards (-): Subtract their value from your score
  - Multiply (2x): Double your final round score
- 🌟 Bonus: +15 points for collecting all 7 regular cards!

#### Score Example
```
Regular Cards: [3,5,7]
Modifiers: +4, -2, ×2
Calculation: (15 + 4 - 2) × 2 = 34 points
```

## 🏆 Winning the Game
- Points accumulate across multiple rounds
- if a player busts they lose their points collected in that round
- The first player to reach the target score or more wins!
- Take too long on your turn and you bust automatically - the table should never
  be stuck waiting on somebody who has walked away
- The final screen shows every score plus the highlights of the game: best round,
  most busts, most ruthless, and whoever got picked on the most


## 🛠️ Technical Details
- Modern web browser required
- JavaScript enabled
- Responsive design (mobile-friendly)
- Supports 2-6 players, humans and bots in any mix

## 🎵 Features
- Real-time multiplayer
- Two decks and four target scores
- Bots with four personalities, for filling a table or practising alone
- A bot can take over the seat of anyone who drops mid-game
- Sound effects and animations
- Interactive tutorial
- Special card effects
- Cross-platform compatibility

## 🧪 Development

```bash
npm install
npm run dev    # http://localhost:3000
npm test       # node:test - unit tests and real socket games
```

Every pull request runs `npm test` on GitHub Actions
([.github/workflows/test.yml](.github/workflows/test.yml)).

The rules live in `lib/` - `deck.js`, `bot.js`, `presence.js`, `rules.js` - precisely so
they can be tested without standing up a server, and `test/` mirrors that file for file.
`test/game-flow.test.js` is the exception: it starts a real `server.js` on a free port
and plays against it with socket.io clients, because the sequences worth testing most
(a Draw Three that itself draws a targeting card, a Select as the last card in the pile,
a turn timing out with a popup open) span several handlers and cannot be called as a
function. It stacks the deck through test-only socket events that only exist when
`HIT7_TEST_HOOKS=1` is set - never in production.

## 📱 Install it on your phone

Open [HIT7.click](https://hit7.click) and use **Add to Home Screen** (Share menu on
iPhone, the ⋮ menu on Android). You get the logo as an app icon, full screen with no
browser bars, and an instant start because the page is cached.

It still needs a connection to play - it is a real-time multiplayer game, so there is no
offline mode. Open it with no signal and it says so rather than sitting there looking
like it works.

## 🚀 Quick Start
1. Visit [HIT7.click](https://hit7.click)
2. Create a new game
3. Share the link with friends
4. Start playing!

## 🔗 Links
- [Play Now](https://hit7.click)
- [Report Issues](https://github.com/JawadAlSaeed/HIT7/issues)
- [Contribute](https://github.com/JawadAlSaeed/HIT7)

## 📜 License
MIT License - Feel free to use and modify while maintaining attribution

## 🙏 Credits
- The game is inspired by the game "Flip 7" by Messy Table Games and published by The Op Games, you can get the physical game from [here](https://theop.games/products/flip-7)
- Developed with the help of Copilot AI assistant
- Sound effects from open-source resources such as [Free Sound](https://freesound.org/)
- Logo created using [Figma](https://www.figma.com/)
- Icons and graphics from the public domain



