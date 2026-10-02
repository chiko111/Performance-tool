// Replays a perf-tool scenario (taps, long presses, swipes with their pauses) on an installed app,
// found by bundle id. Driven by `perf` through `xcodebuild test-without-building`, which passes:
//   PERF_BUNDLE    bundle id of the app under test
//   PERF_SCENARIO  the scenario JSON, base64
//   PERF_ATTACH    "1": use the app as it is (perf has opened the start screen), else relaunch it
// Progress lines start with "PERF_STEP " so the server can show them.
import XCTest

private struct Scenario: Decodable {
  struct Device: Decodable { let width: Double; let height: Double }
  struct Gesture: Decodable {
    let type: String
    let at: Double
    let x: Double?
    let y: Double?
    let x1: Double?
    let y1: Double?
    let x2: Double?
    let y2: Double?
    let durationMs: Double?
    let velocity: Double?
  }
  let device: Device
  let durationMs: Double
  let gestures: [Gesture]
}

// XCUITest waits for the app to be idle before every action; an app that always animates
// (counters, live video) would delay each gesture by seconds. Timing must follow the scenario.
private func disableQuiescenceWaiting() {
  guard let process = NSClassFromString("XCUIApplicationProcess") else { return }
  let oneArgument: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
  let twoArguments: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
  let replacements: [(String, Any)] = [
    ("waitForQuiescenceIncludingAnimationsIdle:", oneArgument),
    ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", twoArguments)
  ]
  for (name, block) in replacements {
    if let method = class_getInstanceMethod(process, NSSelectorFromString(name)) {
      method_setImplementation(method, imp_implementationWithBlock(block))
    }
  }
}

private func step(_ text: String) {
  print("PERF_STEP \(text)")
}

final class PerfReplayTests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    disableQuiescenceWaiting()
  }

  func testReplayScenario() throws {
    let environment = ProcessInfo.processInfo.environment
    let bundle = try XCTUnwrap(environment["PERF_BUNDLE"], "PERF_BUNDLE missing")
    let encoded = try XCTUnwrap(environment["PERF_SCENARIO"], "PERF_SCENARIO missing")
    let scenario = try JSONDecoder().decode(Scenario.self, from: try XCTUnwrap(Data(base64Encoded: encoded)))

    let app = XCUIApplication(bundleIdentifier: bundle)
    if environment["PERF_ATTACH"] == "1" {
      app.activate()
      step("attached \(bundle)")
    } else {
      app.terminate()
      step("launching \(bundle)")
      app.launch()
    }
    let startedAt = Date()

    // Gestures are stored in the points of the capturing device; scale for another screen size.
    let size = app.frame.size
    let scaleX = size.width > 0 ? size.width / scenario.device.width : 1
    let scaleY = size.height > 0 ? size.height / scenario.device.height : 1
    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let point = { (x: Double, y: Double) in origin.withOffset(CGVector(dx: x * scaleX, dy: y * scaleY)) }

    for (index, gesture) in scenario.gestures.enumerated() {
      let due = startedAt.addingTimeInterval(gesture.at / 1000)
      let wait = due.timeIntervalSinceNow
      if wait > 0 { Thread.sleep(forTimeInterval: wait) }
      step("\(index + 1)/\(scenario.gestures.count): \(gesture.type) at \(Int(-startedAt.timeIntervalSinceNow * 1000)) ms (planned \(Int(gesture.at)))")
      switch gesture.type {
      case "tap":
        point(gesture.x ?? 0, gesture.y ?? 0).tap()
      case "longpress":
        point(gesture.x ?? 0, gesture.y ?? 0).press(forDuration: (gesture.durationMs ?? 600) / 1000)
      default:
        let start = point(gesture.x1 ?? 0, gesture.y1 ?? 0)
        let end = point(gesture.x2 ?? 0, gesture.y2 ?? 0)
        start.press(
          forDuration: 0.01,
          thenDragTo: end,
          withVelocity: XCUIGestureVelocity(CGFloat(gesture.velocity ?? 1000)),
          thenHoldForDuration: 0
        )
      }
    }

    let remaining = startedAt.addingTimeInterval(scenario.durationMs / 1000).timeIntervalSinceNow
    if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
    step("done")
  }
}
