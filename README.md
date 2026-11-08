# Last Shelter

*A few survivors, one shared world, and something worth fighting for.*

Last Shelter is a browser-based, top-down 2D cooperative survival game for one to four players. Everyone shares one persistent world: gathering resources, crafting tools, building shelters and fighting enemies together. **The goal is to defeat every enemy on the map.** When the last enemy falls, the entire room wins together.

## Design goals

Good means that cooperation changes what players can achieve. One player gathering wood can support another player's construction; shared storage makes preparation a team activity; and a dangerous encounter can put everyone's progress at risk. The world should give players reasons to coordinate without forcing them to follow one prescribed strategy.

Four design decisions support this experience:

- **Shared consequences.** Players inhabit one authoritative world rather than separate personal instances. Resources, buildings and enemies are part of the same shared experience.
- **Meaningful preparation.** Tools improve gathering and combat, but have limited durability. Bandages consume resources, so healing requires preparation rather than unlimited recovery.
- **Consequential survival.** Death removes the player's inventory and all buildings they have placed. On respawn, every enemy, including previously defeated ones, returns at full health. Failure therefore affects the whole group.
- **Collective victory.** Defeating every enemy provides a clear shared objective. Any connected player can restart the challenge without resetting the surviving players' health, positions or inventories.

## Inspiration

Last Shelter draws inspiration from three pixel-art survival games on Steam: [Necesse](https://store.steampowered.com/app/1169040/Necesse/), [Don't Starve Together](https://store.steampowered.com/app/322330/Dont_Starve_Together/) and [Core Keeper](https://store.steampowered.com/app/1621690/Core_Keeper/).

From Necesse, I looked at how a top-down pixel world connects resource gathering, tool crafting and base building. Don't Starve Together inspired the emphasis on multiplayer cooperation, day-and-night changes and shared survival risks. Core Keeper influenced the combination of exploration, resource collection and combat, where preparation and crafting help players face stronger threats.

Rather than reproducing these games' complex systems, I selected mechanics suited to a smaller cooperative experience. Last Shelter focuses on shared resources, collective building and team combat, with defeating all enemies as its clear objective instead of an endless survival timer.

## Scope and trade-offs

Last Shelter does not require accounts, passwords or separate personal worlds. Signed anonymous browser identities simplify joining, while server-side validation protects shared world state.

I chose not to add trading economies, leaderboards or competitive scoring because ranking players would undermine the cooperative objective. I also removed the earlier dungeon-and-beacon progression in favour of one more understandable overworld objective. Enemies do not spawn endlessly, because that would conflict with the finite victory condition.

Some visual limitations remain: characters have no walking or attack animations, and certain terrain boundaries are still hard edges. I prioritised a coherent playable world and reliable multiplayer simulation over adding visual features without suitable assets.

## Play the game

Open [Last Shelter](https://comp4020-final-jojo111111111025.fly.dev/), enter a player name and the room code (`LAST-SHELTER` by default), and survive together. Use WASD to move, E to gather, Space to attack, H to use a bandage and C to open nearby shared storage.

The [anonymous identity ADR](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/main/docs/adr/001-anonymous-identity.md) explains the identity and authorisation design. [Automated specifications](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/tree/main/spec) document tested behaviour, while the [development process](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/main/PROCESS.md) records implementation decisions, experiments, failures and revisions. Tests can verify individual behaviours, but whether shared risks create meaningful cooperation is ultimately something players must experience.
