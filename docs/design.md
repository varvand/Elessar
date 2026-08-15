# Visual design system

The reasoning behind Elessar's interface, and the validator output that the
palette is accountable to. Read this before changing a colour.

## Stance

This is a monitoring console, most often read in a dim room beside other dark
tooling, so it is **dark-first by intent** rather than by fashion. A dark ground
also makes a luminous globe the focal point instead of fighting it. Light mode is
fully supported — every colour is defined in both modes with its own steps, not an
automatic inversion.

The visual language is *instrument surfaces*: flat panels, hairline rules,
uppercase eyebrow labels, tabular figures. Panels have almost no shadow, because a
console should read as a single machined surface, not as floating cards.

Three rules govern everything:

1. **Data is the brightest thing on screen.** Chrome recedes: gridlines and axes
   are near-invisible, labels are muted, and no decorative colour competes with a
   pin or a bar.
2. **Nothing is conveyed by colour alone.** Every colour-coded value also carries a
   text label. The feed is a full table view of everything on the globe.
3. **Motion is spent, not sprinkled.** The only looping animation is the ring on a
   critical event. It is the strongest pre-attentive cue available, so it is
   reserved for the one thing that must not be missed.

## Colour is computed, not chosen

The palette was validated with a colourblind-separation checker against the exact
surfaces it renders on. **The first attempt failed**, which is the whole argument
for running the check:

```
Palette (dark, surface #121821, categorical): 5 slots
  [WARN] CVD separation      worst adjacent #d95926↔#e66767 ΔE 6.6 (deutan)
  [FAIL] Normal-vision floor worst adjacent #d95926↔#e66767 ΔE 7.1 — below 15
  → FAILED
```

Red beside orange at ΔE 7.1 is hard to tell apart *with full colour vision*.
Violet beside blue measured protanopia ΔE 1.9 — effectively identical for a
protanope. Both looked fine to the eye.

### Categorical: 5 groups, not 18 categories

No palette gives 18 distinguishable hues; past roughly eight, colourblind
separation collapses entirely. So the 18 categories fold into **5 groups** for
colour, and category identity is carried by the text label everywhere it appears.
Colour answers "what kind of thing, at a glance"; the label answers "exactly what".

**The slot ordering is the safety mechanism, not cosmetics.** The validator checks
adjacent pairs (the pairlist for stacked charts), and this sequence is one of the
few orderings that clears every gate in both modes. Reordering it silently
invalidates the result. Stacked charts must render groups in this order.

| Slot | Group | Categories | Dark | Light |
|---|---|---|---|---|
| 1 | Governance | political, diplomacy, economy | `#3987e5` | `#2a78d6` |
| 2 | Security | armed_conflict, terrorism, civil_unrest, cyber | `#d95926` | `#eb6834` |
| 3 | Human | humanitarian, health | `#199e70` | `#1baf7a` |
| 4 | Domain | infrastructure, maritime, aviation, space, other | `#9085e9` | `#4a3aa7` |
| 5 | Hazard | seismic, severe_weather, wildfire, natural_disaster | `#c98500` | `#eda100` |

Passing output:

```
Palette (dark, surface #121821, categorical): 5 slots
  [PASS] Lightness band       all 5 inside L 0.48–0.67
  [PASS] Chroma floor         all 5 >= 0.1
  [PASS] CVD separation       worst adjacent #199e70↔#d95926 ΔE 9.4 (deutan) · tritan 9.4
  [PASS] Normal-vision floor  worst adjacent #9085e9↔#199e70 ΔE 24.6 (normal)
  [PASS] Contrast vs surface  all 5 >= 3:1
  → ALL CHECKS PASS

Palette (light, surface #fbfbfa, categorical): 5 slots
  [PASS] CVD separation       worst adjacent #1baf7a↔#eb6834 ΔE 9.2 (deutan) · tritan 26.6
  [PASS] Normal-vision floor  worst adjacent #1baf7a↔#eb6834 ΔE 27.6 (normal)
  [WARN] Contrast vs surface  below 3:1: aqua 2.72, yellow 2.09 — relief required
  → ALL CHECKS PASS
```

The light-mode contrast warning is **not dismissable**: it obligates the relief
rule, which Elessar satisfies because every chart carries a legend *and* direct
labels, and the feed is itself a table view of the same data.

### Severity: the reserved status palette

Severity is a **state**, not an arbitrary magnitude, so it wears the status palette
rather than a sequential ramp. Status colours are reserved and never reused as a
series colour, so a severity band can never impersonate a category.

| Band | Range | Dark | Light |
|---|---|---|---|
| Critical | 70+ | `#d03b3b` | `#c62f2f` |
| Serious | 50–69 | `#ec835a` | `#d2683c` |
| Elevated | 30–49 | `#fab219` | `#b07b00` |
| Routine | <30 | `#5b7089` | `#78889c` |

All four clear 3:1 against the panel surface. They sit deliberately outside the
categorical lightness band — that separation is what keeps them distinct from
series colours, and it is why the categorical band check "fails" for them by
design.

Bands are coarse on purpose. Severity is an estimate assembled from heterogeneous
sources; four named bands communicate the signal's actual resolution, where a bare
number invites false confidence. The numeric score stays available for sorting and
in the detail view.

## Form choices

**Globe: severity in colour *and* size, redundantly.** A globe is a scatter plot
where any pin can sit beside any other, which means the all-pairs CVD test applies
— and no palette survives it at 5+ hues. Encoding taxonomy in hue would therefore
be unreadable. Encoding severity twice is robust for every viewer, and it answers
the question a globe is actually for: *where is it bad?*

**Timeline: bars, not a smoothed area.** The data is a discrete count per time
bucket. A spline through bucket counts implies instantaneous rates that were never
measured, inventing a continuous curve out of a histogram. Stacked segments carry a
2px surface-coloured gap so adjacent bands read as separate quantities rather than
one blended mass.

**Stat strip: tiles, not charts.** Each answers a single "how many right now"
question. Wrapping a lone figure in axes adds ink without information.

**Hand-rolled SVG for the chart.** A charting library would not give the 2px
stacked-segment gap, bucket-snapping crosshair, or always-present legend — and
those specs are exactly what makes a stacked chart readable.

## Typography

System sans throughout, no display face. Base size 13px: this is a dense console
and vertical space is the scarce resource.

`font-variant-numeric: tabular-nums` on every figure that refreshes in place or
sits in a column. Without it the whole stat strip jitters as digit widths change on
each poll.

Uppercase 10px eyebrow labels with wide tracking read as instrument labelling and
keep headers from competing with data for attention.

## Accessibility

- Every colour-coded value carries a text label; the feed is a table view of the
  globe, and lists unlocated events too, since those have no pin.
- Focus rings are unmistakable — 2px in the focus blue, offset 1px.
- `prefers-reduced-motion` disables the pulse, the shimmer and all transitions.
- The globe canvas has an `aria-live` region reporting the located-event count, and
  the chart carries a descriptive `role="img"` label.
- Keyboard: every control is a real `<button>` or `<input>`; Escape closes the
  detail panel.

## Changing a colour

1. Edit the tokens in `apps/web/src/app/globals.css` — the single source of truth.
2. Re-run the validator against **both** surfaces (`#121821` dark, `#fbfbfa` light).
3. If the categorical set changed, re-run candidate orderings and pick only among
   those that pass every adjacent gate in both modes.
4. Update the tables above with the new output.

`SEVERITY_HEX_DARK` / `SEVERITY_HEX_LIGHT` in `lib/presentation.ts` are the one
sanctioned duplication of the palette: WebGL cannot read CSS custom properties, so
three.js needs concrete hexes. Keep them in step with the CSS.
