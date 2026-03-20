# Old UI Reference Notes — Mon Names Converter

Use `reference/old-index-draft.html` as a **UI/UX reference only**.

## Keep / Reuse These Ideas

### Overall layout
- Centered main card layout
- Clean dark theme
- Mon-friendly typography
- Clear spacing and simple structure

### Main controls
- "From" language selector
- "To" language selector
- Swap button
- One main text input for full name entry
- One main convert/search button

### Result experience
- Single main result panel
- Clean assembled output display
- Interactive choice chips/buttons when one segment has multiple valid outputs
- Immediate visual update when a user selects a different variant

### Supporting UI
- Suggest a Word modal or section
- Customize & Download Card feature
- Recent History section
- About modal/section

## Do NOT Reuse These Old Parts

### Old logic to replace
- Firebase / Firestore integration
- Flat regex replacement logic
- Simple map-based conversion only
- Whitespace splitting as the main fallback strategy

### Why
The new app must be:

- dictionary-first
- full-name lookup first
- automatic internal matching if full exact match is not found
- able to support variant choices like:
  - လျး
  - လယယ့်
  - လရီ
  - လယီ

## New Behavior Required

### Lookup flow
1. User enters one full name string
2. Try exact full-name lookup first
3. If not found, perform dictionary-based longest-match segmentation over the full input string
4. Do not rely on splitting by spaces as the main strategy
5. If a matched segment has multiple valid target variants, render clickable choice chips/buttons
6. Concatenate selected variants into one final assembled output
7. Update the preview immediately when a choice changes

## Data / logic direction

The app should move toward structured data handling such as:
- full-name entries
- aliases
- segment entries
- segment variants
- preferred variants
- verified status

CSV may still be used for import, but runtime behavior should support structured dictionary-style matching.

## Design priority

Preserve the best feel of the old draft:
- polished
- simple
- visually friendly
- community-focused
- easy for Mon/Burmese/English users

But implement it with the current stack:
- Cloudflare Worker
- D1
- static frontend
- plain HTML/CSS/JS
