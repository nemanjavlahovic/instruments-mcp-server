# Example Output

All profile tools return compact, severity-classified text designed for LLM context windows (~80% smaller than raw JSON).

## Time Profiler (CPU)

```
=== Time Profiler ===  severity: [WARNING]  samples: 1587

Hotspots:
  UpdateStack::update() (AttributeGraph)  42.3ms self ━━━━━━╌╌╌╌╌╌╌╌╌ 12.1%
  FeedViewModel.loadItems() (MyApp)        28.1ms self ━━━━╌╌╌╌╌╌╌╌╌╌╌ 8.0%

Main thread blockers:
  [WARNING] FeedViewModel.loadItems()  28.1ms

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## SwiftUI View Performance

```
=== SwiftUI ===  severity: [WARNING]  total evals: 847  views: 23

Views:
  [CRITICAL] FeedCardView  x156  65.5ms
  [WARNING] AvatarView     x89   12.3ms
  [OK] HeaderView          x12   1.2ms

Excessive re-renders: 2 views flagged

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## App Launch

```
=== App Launch ===  severity: [CRITICAL]  total: 1340ms  type: cold

Phases:
  [CRITICAL] Dynamic Library Loading  580ms  ━━━━━━━━━━━━━━━
  [CRITICAL] UIKit Initialization     310ms  ━━━━━━━━╌╌╌╌╌╌╌
  [WARNING] Initial Frame Rendering   290ms  ━━━━━━━╌╌╌╌╌╌╌╌

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## Animation Hitches

```
=== Animation Hitches ===  severity: [CRITICAL]  total: 3 (1 critical, 2 warning, 0 minor, 0 micro)

Hang events:
  [CRITICAL] 1240ms  start: 5.2s
    stack: FeedViewModel.loadItems() > NetworkManager.fetch() > URLSession.data()
  [WARNING] 380ms  start: 12.1s

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## Memory Leaks

```
=== Leaks ===  severity: [WARNING]  total: 12 objects  4.8 KB

Leak groups:
  [WARNING] NSMutableArray (Foundation)  x5  2.1 KB
  [minor] ClosureContext (MyApp)         x4  1.6 KB
  [minor] NSObject (CoreFoundation)      x3  1.1 KB

By library:
  Foundation  5 leaks  2.1 KB
  MyApp       4 leaks  1.6 KB

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## Allocations (Memory)

```
=== Allocations ===  severity: [WARNING]  persistent: 45.2 MB  transient: 128.7 MB

Top categories:
  [WARNING] VM: ImageIO_JPEG_Data  12.8 MB persistent
  [minor] malloc 128.00           8.4 MB persistent
  [OK] VM: CoreAnimation          3.2 MB persistent

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## Energy Log

```
=== Energy ===  severity: [WARNING]  avg impact: 8.2/20  duration: 30.0s

Components:
  [WARNING] CPU        6.5/20
  [minor] Networking   3.2/20
  [OK] GPU             1.0/20
  [OK] Location        0.0/20

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

## Network

```
=== Network ===  severity: [WARNING]  requests: 47  errors: 3  domains: 5

By domain:
  [WARNING] api.example.com   32 reqs  avg 840ms  2 errors
  [OK] cdn.example.com        12 reqs  avg 120ms  0 errors
  [minor] analytics.co         3 reqs  avg 2100ms  1 error

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```
