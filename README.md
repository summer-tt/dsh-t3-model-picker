# dsh-t3-model-picker

A model picker for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) composer,
ported from [T3 Code](https://github.com/pingdotgg/t3code)'s model selector.

![The picker: provider rail, grouped search, favorites and jump shortcuts](assets/demo.gif)

Open the picker with `Cmd`/`Ctrl`+`Shift`+`M`, search across every provider,
star what you use, and reach the first nine rows with
`Cmd`/`Ctrl`+`1`…`9`.

## Credit

The selector this plugin implements is T3 Code's `ProviderModelPicker`. The
provider rail, the borderless search field, the row layout with a provider
footer, the favorites model, the tiered search ranking, and the `Cmd`+`1`…`9`
jump chords are all theirs. T3 Code is
[open source under MIT](https://github.com/pingdotgg/t3code/blob/main/LICENSE);
this port keeps the same behaviour and swaps the data underneath for DeepSeek
Harness's model directory. Please support the original project.

## Features

- **Provider rail.** A 44px column with `Favorites` first and one tile per
  advertised provider. The rail and composer show provider logos where available.
  Model rows show the provider name. The active rail entry carries a
  primary-colored indicator.
- **Search.** The field takes focus when the picker opens. Matching uses tiered
  scoring over the model name, its description, the provider id and the
  provider name, including subsequence matching for queries of three characters
  or more, with a small boost for favorites. Results are grouped under provider
  headings.
- **Favorites.** Stars are saved in `t3-model-picker.favorites` in the DSH Web profile. Browsers connected to that profile share the list. Each entry stores the model and provider IDs and the remote server ID, with `null` for the local Host.
- **Browser favorites import.** Reload the upgraded DSH page from the browser and address where you saved favorites. T3 merges them into the profile when the plugin loads, then clears the browser copy after DSH confirms it. Legacy favorites were shared by all DSH pages on the same browser origin. If several deployments share an origin, open the intended destination first.
- **Jump shortcuts.** `Cmd`+`1`…`9` on macOS, `Ctrl`+`1`…`9` elsewhere, select
  the first nine rows of the visible list; each of those rows shows its chord in
  a `kbd` chip. The listener is live only while the card is open.
- **Toggle shortcut.** `Cmd`+`Shift`+`M` on macOS, `Ctrl`+`Shift`+`M`
  elsewhere, opens the card when it is closed and closes it when it is open,
  from anywhere in the window including the composer editor. The trigger's
  tooltip carries the chord. On a locked session the chord is inert, as the
  trigger is. The shift leaves the bare `Cmd`+`M` text binding alone.
- **Unavailable models.** Providers the host does not report as routable are
  marked on their rows, on the rail tile's tooltip, and on the trigger.
- **Reasoning effort.** The composer button shows the current effort beside the
  model name when the model advertises effort levels. A discrete slider in the picker footer selects the effort supported by the current model. In compact layout the button retains the effort and its tooltip shows both the model and effort.
- **Session speed and context window.** A compatible Magpie Connect host adds two sliders for configured base models. Speed requests Standard, Fast or Ultrafast. The context slider sets the local token budget. Each slider and its composer-button indicator appears when its corresponding host control is enabled. An outline bolt means Fast, a solid bolt means Ultrafast, and Standard has no bolt. Select a base model such as `codex/gpt-6.2-sol` to use them. Existing group routes keep their own model IDs.
- **Save on close.** Select the checked model again, click outside, or toggle the picker to close it and save the edited controls together on a compatible Host. Escape closes the picker and discards the current control edits. The composer waits for confirmation before sending. A failed save restores the last confirmed settings, keeps the message draft, and uses the native DSH notification.
- **Immediate model switch.** Picking another model keeps the picker open and immediately updates the composer's model button. The picker saves edits for the previous model before switching and loads the new model's controls after confirmation. The composer waits for the switch before sending. A failed or timed-out switch restores the previous model, keeps the message draft, and uses the native DSH notification.
- **Edits during a run.** When the Magpie Connect host advertises running edits for the selected model, you can adjust speed, reasoning effort, and the context window while the session runs. The composer shows the effective window while the slider keeps your choice. If the host cannot apply a smaller window, DSH shows a notification with the retained window and keeps the other saved edits. Older hosts keep the controls read-only during a run.
- **Agent teamwork.** The picker footer shows a root session's saved Team
  setting when the host exposes Agent Teams. The switch is available regardless
  of the model's effort levels. Disabling Team after a model request opens
  a confirmation using the host's in-app warning dialog.

## Install

For the session controls, install the matching local T3 and Magpie Connect bundles in the Web profile. The earlier logo-only release can be installed with:

```sh
dsh plugin --profile web add https://github.com/summer-tt/dsh-t3-model-picker/releases/download/fork-1.1.3-logos.1/dsh-t3-model-picker.tgz
```

This release uses the same package name as upstream and replaces its copy in
that profile. Removing the bundle restores the shipped model selector.

## Screenshots

| Picker open on Favorites | Grouped search results | Favorites after starring |
|---|---|---|
| ![Favorites pane](assets/picker-open.png) | ![Search grouped by provider](assets/search-grouped.png) | ![Favorites list](assets/favorites.png) |

## How it works

The composer's `conversation.input.model` seat is a `single` slot. Two
occupants can coexist there at different priorities, and the lowest live
priority renders, so this plugin registers at `-1` and the shipped
`ModelSelect` at its default `0` stops rendering.

Both read the *same* per-session model directory (`ctx.modelDirectories`), which
is also what the `/model` command popup uses. A model chosen here is what those
surfaces show next, and a selection made there is what this picker highlights.

| File | Role |
|---|---|
| `package.json` | Bundle manifest: `dsh.bundle.patch` plus the `dsh.client` web half |
| `cordis.patch.yml` | One `insert` row mounting the bundle |
| `index.js` | Host half — empty; the feature is entirely browser-side |
| `client.js` | Client half: the picker, its styles, favorites and shortcuts |

## Differences from T3 Code

Four deliberate departures, all recorded in `client.js`:

- Search results are grouped under provider headings. T3 renders one flat
  ranked list with the provider named on each row.
- A footer row keeps the reasoning-effort selector reachable. T3 keeps effort
  in a sibling control, while in DeepSeek Harness this seat is the composer's
  only effort control.
- The row of the model in use carries a check mark. This seat is single-select
  and the trigger is not always in view.
- `Cmd`/`Ctrl`+`Shift`+`M` opens and closes the card. T3 leaves opening to the
  trigger alone, so a chord bound to the trigger would mean holding `Cmd` and
  reaching for the mouse.

## Known limits

- The picker needs a session-scoped model directory. Addressed subagent
  sessions expose none, so the seat stays absent there and the chord has
  nothing to open.
- Jump chords stay open-only, as in T3. `Cmd`/`Ctrl`+`Shift`+`M` is the one
  chord that works with the card closed.
- The effort footer only ever shows models whose provider advertises reasoning
  metadata.

## Development

No build step: `client.js` is plain JavaScript in the format the client module
loader takes. Edit it and reload the page.

`scripts/verify-shortcuts.mjs` checks the chords against the real component. It
mounts `client.js` in a jsdom page with React and dispatches real key events at
the window, so a chord change is verified without the desktop app. The plugin
has no dependencies, so the harness brings its own:

```sh
npm install --no-save react react-dom jsdom
node scripts/verify-shortcuts.mjs
```

`scripts/` also holds the recording tooling used for the assets above. It drives
the running DeepSeek Harness page over the Chrome DevTools Protocol, so no
browser download is needed:

```sh
node scripts/record.mjs <run-dir>                       # frames + stills + timeline
node scripts/encode-gif.mjs <run-dir> <out.gif> --fps 12 --speed 1.8 --start 1.14
```

`record.mjs` expects the page to show a session whose composer carries the
picker, and it restores the browser's favorites when it finishes. The encoder
crops, resizes, and assembles the GIF with `sharp`; it needs no `ffmpeg`.

## Releasing

[RELEASING.md](https://github.com/yusufameri/dsh-t3-model-picker/blob/main/RELEASING.md)
covers the npm token setup, the tag-driven release workflow, and the manual
publish fallback.

## License

[MIT](LICENSE). The interface this plugin reproduces comes from
[T3 Code](https://github.com/pingdotgg/t3code), MIT licensed, by its authors.
