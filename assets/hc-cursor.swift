// hc-cursor — native cursor control for Harness Code computer use.
// Animates the REAL cursor with eased motion via CGEvent (like Codex), then clicks.
// All synthetic events are tagged; `watch` mode runs a listen-only CGEventTap and
// prints "USER" whenever an UNTAGGED (= human) mouse event arrives, so the host can
// hand control back the moment the user touches the mouse — even mid-glide.
//   hc-cursor pos                          → prints "x,y"
//   hc-cursor move <x> <y> [ms]            → glide to point
//   hc-cursor click <x> <y> [left|right|double] [ms]
//   hc-cursor watch                        → stream "USER" lines on human mouse input
// Requires Accessibility permission (same grant cliclick uses).
import Foundation
import CoreGraphics

let MAGIC: Int64 = 0x4841524E   // "HARN" — marks our synthetic events

func post(_ e: CGEvent?) {
    e?.setIntegerValueField(.eventSourceUserData, value: MAGIC)
    e?.post(tap: .cghidEventTap)
}
func cur() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func glide(to x: Double, _ y: Double, ms: Double) {
    let start = cur()
    let steps = max(Int(ms / 16.0), 1)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2   // easeInOutQuad
        let p = CGPoint(x: start.x + (x - Double(start.x)) * e,
                        y: start.y + (y - Double(start.y)) * e)
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                     mouseCursorPosition: p, mouseButton: .left))
        usleep(16000)
    }
}

let a = CommandLine.arguments
guard a.count >= 2 else { exit(1) }

switch a[1] {
case "pos":
    let p = cur()
    print("\(Int(p.x)),\(Int(p.y))")
case "move":
    guard a.count >= 4, let x = Double(a[2]), let y = Double(a[3]) else { exit(1) }
    glide(to: x, y, ms: a.count > 4 ? (Double(a[4]) ?? 450) : 450)
case "click":
    guard a.count >= 4, let x = Double(a[2]), let y = Double(a[3]) else { exit(1) }
    let kind = a.count > 4 ? a[4] : "left"
    glide(to: x, y, ms: a.count > 5 ? (Double(a[5]) ?? 450) : 450)
    usleep(80000)
    let p = CGPoint(x: x, y: y)
    let btn: CGMouseButton = kind == "right" ? .right : .left
    let downT: CGEventType = kind == "right" ? .rightMouseDown : .leftMouseDown
    let upT: CGEventType = kind == "right" ? .rightMouseUp : .leftMouseUp
    let clicks = kind == "double" ? 2 : 1
    for i in 1...Int64(clicks) {
        let d = CGEvent(mouseEventSource: nil, mouseType: downT, mouseCursorPosition: p, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: i)
        post(d)
        usleep(40000)
        let u = CGEvent(mouseEventSource: nil, mouseType: upT, mouseCursorPosition: p, mouseButton: btn)
        u?.setIntegerValueField(.mouseEventClickState, value: i)
        post(u)
        usleep(90000)
    }
case "watch":
    let mask: CGEventMask =
        (1 << CGEventType.mouseMoved.rawValue) |
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.rightMouseDown.rawValue) |
        (1 << CGEventType.leftMouseDragged.rawValue) |
        (1 << CGEventType.scrollWheel.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, _, event, _ in
            if event.getIntegerValueField(.eventSourceUserData) != MAGIC {
                print("USER")
                fflush(stdout)
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: nil) else { exit(1) }
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    CFRunLoopRun()
default:
    exit(1)
}
