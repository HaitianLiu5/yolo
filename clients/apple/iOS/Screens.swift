import AuthenticationServices
import SwiftUI
import YoloKit

/// Bonjour's servers to pick from, or an address to type.
struct FindServerView: View {
  @Environment(AppModel.self) private var model
  let error: String?
  @State private var typed = ""

  var body: some View {
    NavigationStack {
      Form {
        if let error {
          Section { Text(error).foregroundStyle(.red) }
        }
        Section("Found on this network") {
          if model.discovered.isEmpty {
            Label("Looking for Yolo on this network…", systemImage: "wifi").foregroundStyle(.secondary)
          }
          ForEach(model.discovered) { server in
            Button {
              model.choose(server)
            } label: {
              VStack(alignment: .leading) {
                Text(server.address.host)
                if server.name != server.address.host {
                  Text(server.name).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        Section("Or type its address") {
          TextField("yolo.example.com", text: $typed)
            .keyboardType(.URL)
            .textContentType(.URL)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .submitLabel(.go)
            .onSubmit { model.connect(typed: typed) }
          Button("Connect") { model.connect(typed: typed) }
            .disabled(typed.isEmpty)
        }
      }
      .navigationTitle("Connect to your Yolo")
    }
  }
}

/// Anyone on the network can advertise `_yolo._tcp`, so the owner confirms
/// the host, shown in full, with one tap.
struct ConfirmServerView: View {
  @Environment(AppModel.self) private var model
  let server: DiscoveredServer

  var body: some View {
    VStack(spacing: 24) {
      Text("Pair with this Yolo?").font(.title.bold())
      Text(server.address.origin).font(.body.monospaced()).multilineTextAlignment(.center)
      Button("Pair") { model.confirm(server) }.buttonStyle(.borderedProminent)
      Button("Back") { model.findServer() }
    }
    .padding(24)
  }
}

/// The code to approve: on this device, in a web sheet where the owner's
/// passkey for their domain signs in, or from another device by the QR code
/// or the short code. The host shows again, so the owner sees which server
/// asks.
struct PairingView: View {
  @Environment(AppModel.self) private var model
  let address: ServerAddress
  @State private var approval = ApprovalSheet()

  var body: some View {
    ScrollView {
      VStack(spacing: 24) {
        Text("Pair this \(ThisDevice.noun)").font(.title.bold())
        Text(address.host).font(.headline.monospaced())
        if let code = model.pairingCode {
          Button("Allow on this \(ThisDevice.noun)") {
            if let url = URL(string: code.verificationURIComplete) { approval.open(url) }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          ZStack {
            RoundedRectangle(cornerRadius: 16).fill(.white)
            QRCode(text: code.verificationURIComplete).padding(16)
          }
          .frame(width: 220, height: 220)
          Text(code.userCode).font(.system(size: 40, weight: .bold, design: .monospaced))
          Text("or open \(code.verificationURI.replacingOccurrences(of: "https://", with: "")) on another device")
            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        } else {
          ProgressView()
        }
        Text(model.pairingStatus).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        Button("Back") { model.cancelPairing() }
      }
      .padding(24)
      .frame(maxWidth: 600)
      .frame(maxWidth: .infinity)
    }
    // Paired, or gone back: the sheet has nothing left to approve.
    .onDisappear { approval.cancel() }
    .onChange(of: model.pairingCode) { approval.cancel() }
  }
}

/// The approval page in `ASWebAuthenticationSession`, which shares Safari's
/// sign-in and passkeys for the owner's domain. The page never calls back:
/// pairing goes on by polling, and the sheet is closed when it is done.
@MainActor
final class ApprovalSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func open(_ url: URL) {
    cancel()
    let session = ASWebAuthenticationSession(url: url, callback: .customScheme("yolo")) { _, _ in }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    self.session = session
    session.start()
  }

  func cancel() {
    session?.cancel()
    session = nil
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
      return scene?.keyWindow ?? ASPresentationAnchor()
    }
  }
}

struct UpdateView: View {
  @Environment(AppModel.self) private var model
  let address: ServerAddress
  let appIsOlder: Bool

  var body: some View {
    VStack(spacing: 24) {
      Text(appIsOlder ? "Update Yolo on this \(ThisDevice.noun)" : "Upgrade your Yolo server").font(.title.bold())
        .multilineTextAlignment(.center)
      Text(appIsOlder
        ? "\(address.host) runs a newer Yolo than this app speaks. Update the app from TestFlight or the App Store."
        : "\(address.host) runs an older Yolo than this app speaks. Upgrade the server, then open this app again.")
        .multilineTextAlignment(.center)
      Button("Choose another server") { Task { await model.forgetServer() } }
    }
    .padding(24)
    .frame(maxWidth: 600)
  }
}

/// What the connection to Yolo is doing, and forgetting the server.
struct SettingsScreen: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      Form {
        Section("Connection") {
          if let paired = model.paired {
            LabeledContent("Server", value: paired.address.host)
            LabeledContent("Device", value: paired.credential.deviceId ?? "—")
          }
          LabeledContent("Realtime", value: status)
          LabeledContent("Media path", value: model.mediaPath.map { $0.path?.rawValue ?? "none" } ?? "—")
          LabeledContent("Playback", value: model.playback ?? "—")
        }
        Section {
          Button("Forget this server", role: .destructive) { Task { await model.forgetServer() } }
        }
      }
      .navigationTitle("Settings")
    }
  }

  private var status: String {
    switch model.realtimeStatus {
    case .connecting: "connecting"
    case .online: "online"
    case .offline: "offline"
    }
  }
}
