# Companion

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module that turns the panel's
touch screen and its 15-key Stream Deck into [Bitfocus Companion](https://bitfocus.io/companion)
surfaces.

On first start it asks how to run:

- **Companion on this panel** (key 6): the module finds an installed Companion, starts it and connects
  to it on `127.0.0.1`. Buttons, connections and pages are set up in a browser at
  `http://<panel address>:8000`.
- **Companion Satellite** (key 8): the module connects to a Companion already running on another
  computer, on its Satellite port (16622). Buttons are set up on that computer.

Either way the module speaks the Companion Satellite API itself (no separate Satellite app) and
registers two surfaces, named after the panel's host name:

- `rcs-<name>-keys`: the Stream Deck, 5×3.
- `rcs-<name>-touch`: a grid of touch buttons, 12×3 by default (also 8×2, 6×2, 4×1, or 11×2 "Key
  size" in Setup). 12×3 and Key size draw buttons about the size of a Stream Deck key.

### Where Companion is found

With no folder set, the module looks in the usual install places and uses the first Companion it finds:

- Linux and the Pi: `/opt/companion`, `/usr/local/companion`, `/usr/lib/companion`, `~/companion`,
  `~/companion-headless` (the headless build, `companion_headless.sh`).
- macOS: `/Applications/Companion.app`, `~/Applications/Companion.app`, `/opt/companion`.
- Windows: `Companion` under `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%\Programs`.

A desktop install is started from its bundled server: `main.js` with the node in `node-runtimes/` that its
`package.json` asks for (Companion 5 ships several, such as `node22` and `node26`). If a Companion is
already running on the computer (the desktop app, say), the module uses that one through its Satellite
port instead of starting a second one.

A desktop install started by the module uses the desktop app's own config (`~/Library/Application
Support/companion` on macOS, `%APPDATA%\companion` on Windows, `~/.config/companion` on Linux, or
`COMPANION_CONFIG_BASEDIR`), so it shows the same buttons as opening the app, and a module Reset never
touches it. Only the headless build, as on the panel, keeps its config in the module's data folder. If nothing is
found, the panel and the web view's Setup page list the places looked in, and Setup takes a folder;
clearing it goes back to searching. The module looks again every 10 seconds, so installing Companion
needs no restart.

### Updating Companion

In "on this panel" mode, Setup on the web view has an Update Companion card. Check for updates asks
Bitfocus's public packages API (`api.bitfocus.io/v1/product/companion/packages`, the one CompanionPi's
updater uses; no Bitfocus sign-in) for the latest stable build for this computer. Nothing is asked
until someone opens that page, and nothing is downloaded until someone presses Update and confirms.

- Linux and the Pi (`.tar.gz`): the module downloads the build, stops Companion, puts the new build
  in the install folder (the old one stays beside it as `<folder>.previous`) and starts it again.
- macOS (`.dmg`) and Windows (`.exe`): the installer is saved to Downloads and opened; the person
  quits Companion and finishes it.

A Companion running outside the module (a CompanionPi service, say) is updated where it runs.

### Web view

The web view has Buttons (the touch grid and the Stream Deck, both pressable), Status (connection,
surfaces and Companion's recent output) and Setup (mode, address and port, folder, grid) pages.

## Companion is the source of truth

Every button face comes from Companion and is never saved. Config holds only the choice above, the
Companion address and port, the grid size and the Companion folder; there is no other module state.
Starting, restoring a save, resuming after a power cut and reconnecting only register the two
surfaces (`ADD-DEVICE`), which tells Companion they exist and changes nothing else. A `KEY-PRESS`
goes out only when someone touches a key or a tile, and a press is never replayed after a reconnect.
`PING` is the only thing sent on a timer.

Some details that follow from that:

- Two screens holding the same tile (the panel and a web view mirror) make one press; it is
  released when the last one lets go, or when a screen disconnects.
- When the system borrows the keys (panel lock, a Settings keypad) or the panel UI is hidden, held
  keys and tiles are released.
- Brightness stays with the system (`BRIGHTNESS=false`), and Companion's own PIN lock is drawn by
  Companion on the keys.
- In "on this panel" mode, the headless build keeps its config in the module's data folder
  (`<data>/companion`). Companion itself may run its own startup triggers when it starts: that is
  Companion's configuration, not something this module sends.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK
until it is published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # unit tests against a mock Companion and the SDK's fake controller
npm run mock           # a pretend Companion on 127.0.0.1:16622 (--port, --rgb for Companion 3 style raw bitmaps)
npm run dev            # the simulator at http://127.0.0.1:5173/sim with this module
```

In the simulator, open the module, tap **Connect to Companion** and type `127.0.0.1`. The mock draws
show-style buttons, latches the toggles and prints every press it receives.

Anything that talks to live show equipment is developed against the mock first. Check with the
owner before pointing a development build at a Companion that runs a show.

## Releasing

Every merge to `main` is a release (`.github/workflows/release.yml`), versioned from the PR title:
`feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`companion-<version>.zip` and its `.sig` as a GitHub release here, where units find it through the
module index in [horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key. Make one with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`, keep `rcs-signing.key` safe (it is
  git-ignored), and add the printed public key to this module's entry in `index.json` in rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the
  workflows can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: first-start choice, keys, touch presses, config |
| `src/client.ts` | The Satellite connection: registers surfaces, mirrors key faces, keepalive, reconnects |
| `src/protocol.ts` | Satellite API lines: parsing, quoting, colours |
| `src/png.ts` | Raw RGB bitmaps (Companion 3) to PNG |
| `src/runner.ts` | Runs Companion's headless build on this panel and restarts it if it exits |
| `src/mock.ts`, `src/mock-cli.ts` | The mock Companion |
| `ui/index.html` | The panel UI, 1824×440: choice, address, Buttons, Status, Setup |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |
