import SwiftUI
import YoloKit

/// Bonjour's servers to pick from, or an address to type with the Siri
/// Remote or the iPhone's keyboard.
struct FindServerView: View {
  @Environment(AppModel.self) private var model
  let error: String?
  @State private var typed = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 40) {
      Text("Connect to your Yolo").font(.largeTitle.bold())
      if let error {
        Text(error).foregroundStyle(.red)
      }
      if model.discovered.isEmpty {
        Label("Looking for Yolo on this network…", systemImage: "wifi")
          .foregroundStyle(.secondary)
      } else {
        Text("Found on this network").font(.headline)
        ForEach(model.discovered) { server in
          Button {
            model.choose(server)
          } label: {
            VStack(alignment: .leading) {
              Text(server.address.host).font(.title3)
              if server.name != server.address.host {
                Text(server.name).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }
      Text("Or type its address").font(.headline)
      HStack {
        TextField("yolo.example.com", text: $typed)
          .keyboardType(.URL)
          .textContentType(.URL)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .onSubmit { model.connect(typed: typed) }
        Button("Connect") { model.connect(typed: typed) }
          .disabled(typed.isEmpty)
      }
    }
    .padding(80)
    .frame(maxWidth: 1400, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// Anyone on the network can advertise `_yolo._tcp`, so the owner confirms
/// the host, shown in full, with one press.
struct ConfirmServerView: View {
  @Environment(AppModel.self) private var model
  let server: DiscoveredServer

  var body: some View {
    VStack(spacing: 48) {
      Text("Pair with this Yolo?").font(.largeTitle.bold())
      Text(server.address.origin).font(.title2.monospaced())
      HStack(spacing: 40) {
        Button("Pair") { model.confirm(server) }
        Button("Back") { model.findServer() }
      }
    }
    .padding(80)
  }
}

/// The QR code of `verification_uri_complete` with the short code beside
/// it and the host again, so the owner sees which server asks.
struct PairingView: View {
  @Environment(AppModel.self) private var model
  let address: ServerAddress

  var body: some View {
    HStack(spacing: 100) {
      ZStack {
        RoundedRectangle(cornerRadius: 24).fill(.white)
        if let code = model.pairingCode {
          QRCode(text: code.verificationURIComplete).padding(24)
        } else {
          ProgressView().tint(.black)
        }
      }
      .frame(width: 520, height: 520)

      VStack(alignment: .leading, spacing: 32) {
        Text("Pair this Apple TV").font(.largeTitle.bold())
        Text("Scan with your phone and allow it with your passkey.")
        if let code = model.pairingCode {
          Text(code.userCode).font(.system(size: 76, weight: .bold, design: .monospaced))
          Text("or open \(code.verificationURI.replacingOccurrences(of: "https://", with: ""))")
            .foregroundStyle(.secondary)
        }
        Text(address.host).font(.headline.monospaced())
        Text(model.pairingStatus).foregroundStyle(.secondary)
        Button("Back") { model.cancelPairing() }
      }
      .frame(maxWidth: 900, alignment: .leading)
    }
    .padding(80)
  }
}

struct UpdateView: View {
  @Environment(AppModel.self) private var model
  let address: ServerAddress
  let appIsOlder: Bool

  var body: some View {
    VStack(spacing: 40) {
      Text(appIsOlder ? "Update Yolo on this Apple TV" : "Upgrade your Yolo server").font(.largeTitle.bold())
      Text(appIsOlder
        ? "\(address.host) runs a newer Yolo than this app speaks. Update the app from TestFlight or the App Store."
        : "\(address.host) runs an older Yolo than this app speaks. Upgrade the server, then open this app again.")
        .multilineTextAlignment(.center)
        .frame(maxWidth: 1200)
      Button("Choose another server") { Task { await model.forgetServer() } }
    }
    .padding(80)
  }
}

/// Stage 1's home screen starts here: for now, what the connection to Yolo
/// is doing.
struct HomeView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      Text("Yolo").font(.largeTitle.bold())
      if let paired = model.paired {
        row("Server", paired.address.host)
        row("Device", paired.credential.deviceId ?? "—")
      }
      row("Realtime", status)
      row("Media path", model.mediaPath.map { $0.path?.rawValue ?? "none" } ?? "—")
      row("Playback", model.playback ?? "—")
      Button("Forget this server") { Task { await model.forgetServer() } }
        .padding(.top, 40)
    }
    .padding(80)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var status: String {
    switch model.realtimeStatus {
    case .connecting: "connecting"
    case .online: "online"
    case .offline: "offline"
    }
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 24) {
      Text(label).foregroundStyle(.secondary).frame(width: 260, alignment: .leading)
      Text(value).font(.body.monospaced())
    }
  }
}
