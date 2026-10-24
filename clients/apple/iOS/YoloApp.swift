import SwiftUI
import UIKit

/// Yolo for iPhone and iPad (Agent Note 2026-10-23-iphone-and-ipad-client):
/// a screen of kind "phone" that speaks Yolo's client protocol through
/// YoloKit and the app layer it shares with the Apple TV app.
@main
struct YoloApp: App {
  @UIApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task { model.launch() }
        .onChange(of: scenePhase) { old, phase in
          // Back from the background, not the launch.
          if phase == .active && old == .background { model.becameActive() }
        }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      switch model.screen {
      case .starting:
        ProgressView()
      case .findServer(let error):
        FindServerView(error: error)
      case .confirm(let server):
        ConfirmServerView(server: server)
      case .checking(let address):
        ProgressView("Checking \(address.host)…")
      case .pairing(let address):
        PairingView(address: address)
      case .updateClient(let address):
        UpdateView(address: address, appIsOlder: true)
      case .updateServer(let address):
        UpdateView(address: address, appIsOlder: false)
      case .ready:
        MainTabs()
      }
    }
    .animation(.default, value: model.screen)
    .onChange(of: model.player.isPresented) { _, shown in Orientation.playing(shown) }
    .fullScreenCover(isPresented: Binding(get: { model.player.isPresented }, set: { shown in
      if !shown { model.leftPlayer() }
    })) {
      PlayerScreen()
    }
  }
}

/// The orientations the app allows, which playback narrows on iPhone.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
    MainActor.assumeIsolated { Orientation.allowed }
  }
}

/// An iPhone plays in landscape, turned there as the player opens and held
/// there until it closes, as video apps do; browsing turns freely. An iPad
/// keeps the way it is held.
@MainActor
enum Orientation {
  static var allowed: UIInterfaceOrientationMask = .all

  static func playing(_ playing: Bool) {
    guard UIDevice.current.userInterfaceIdiom == .phone,
          let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
    else { return }
    allowed = playing ? .landscape : .allButUpsideDown
    scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    scene.requestGeometryUpdate(.iOS(interfaceOrientations: playing ? .landscape : .portrait))
    // Back to free turning once the phone stands upright again.
    if !playing { allowed = .allButUpsideDown }
  }
}
