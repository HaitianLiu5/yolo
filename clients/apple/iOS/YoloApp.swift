import SwiftUI

/// Yolo for iPhone and iPad (Agent Note 2026-10-23-iphone-and-ipad-client):
/// a screen of kind "phone" that speaks Yolo's client protocol through
/// YoloKit and the app layer it shares with the Apple TV app.
@main
struct YoloApp: App {
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
    .fullScreenCover(isPresented: Binding(get: { model.player.isPresented }, set: { shown in
      if !shown { model.leftPlayer() }
    })) {
      PlayerScreen(
        player: model.player.player, caption: model.player.caption, danmaku: model.danmaku,
        time: { model.player.position }, close: { model.leftPlayer() }
      )
      .ignoresSafeArea()
    }
  }
}
