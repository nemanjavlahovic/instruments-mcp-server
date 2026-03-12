# Prepare Your App for AI-Driven Profiling

**The single biggest thing you can do: add `accessibilityIdentifier` to your key UI elements.**

With accessibility identifiers, the agent composes an entire profiling scenario in one tool call — no screenshots, no guessing, no wasted context:

```
You:   "Profile CPU while logging in and scrolling the feed"
Agent: calls profile_scenario with tap(id: "emailField"), type("user@test.com"),
       tap(id: "loginButton"), gesture(scroll-down)...
       → Done. Structured results. One call.
```

Without them, the agent has to snapshot the screen, parse a JSON tree of every UI element, find the right button by label or coordinates, tap, snapshot again to verify... repeat for every interaction. That's 6+ tool calls and 10KB+ of context burned on navigation instead of profiling.

## Add Identifiers to Key Elements

```swift
emailField.accessibilityIdentifier = "emailField"
loginButton.accessibilityIdentifier = "loginButton"
feedList.accessibilityIdentifier = "feedList"
searchBar.accessibilityIdentifier = "searchBar"
```

## Targeting Methods Compared

| Method | Reliability | Speed | Context cost |
|---|---|---|---|
| `accessibilityIdentifier` | Best — unique, stable across layouts | Instant | Zero |
| `accessibilityLabel` | Good — but may match multiple elements | Instant | Zero |
| Coordinates (x, y) | Fragile — breaks on layout changes | Instant | Requires snapshot first |

**Tip**: If your app already uses `accessibilityLabel` for VoiceOver, you're most of the way there. Add `accessibilityIdentifier` to key interactive elements (buttons, fields, tabs) and the agent can drive your entire app without ever snapshotting.
