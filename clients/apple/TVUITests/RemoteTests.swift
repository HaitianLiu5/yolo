import XCTest

/// Drives the paired app with the Siri Remote's presses, as the owner does.
/// It needs a simulator that is already paired with a Yolo server, so it is
/// run by hand (`-only-testing:YoloTVUITests`), never by CI, and it leaves
/// what it played on the owner's server.
final class RemoteTests: XCTestCase {
  @MainActor
  func testHomeOpensWithItsRowsAndPlaysACardFromTheRemote() throws {
    let app = XCUIApplication()
    app.launch()
    let shelf = app.staticTexts["Continue Watching"]
    try XCTSkipUnless(shelf.waitForExistence(timeout: 20), "This simulator is not paired, or its history is empty")

    // From the tab bar down to the card the focus engine finds below it,
    // then play it.
    XCUIRemote.shared.press(.down)
    XCUIRemote.shared.press(.select)

    // The system player covers the home screen once Yolo's `load` arrives.
    let covered = expectation(for: NSPredicate(format: "hittable == false"), evaluatedWith: shelf)
    wait(for: [covered], timeout: 60)
  }
}
