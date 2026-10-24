import UIKit
import VideoToolbox
import YoloKit

/// What this iPhone or iPad tells Yolo about itself.
@MainActor
enum ThisDevice {
  static let identity = ClientIdentity.iPhone
  /// What the app calls this device in what it shows: "iPhone" or "iPad".
  static var noun: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
  static var pairingPrompt: String { "Allow this \(noun) with your passkey, here or by scanning the code on another device." }
  static let logSubsystem = "dev.yolo.ios"

  /// The approval page's starting name, which the owner can change there.
  static var name: String { UIDevice.current.name }

  /// The app's window in pixels, as it is held now.
  static var viewport: (width: Int, height: Int) {
    let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
    let screen = scene?.screen
    let size = scene?.windows.first?.bounds.size ?? screen?.bounds.size ?? CGSize(width: 390, height: 844)
    let scale = screen?.scale ?? 3
    return (Int(size.width * scale), Int(size.height * scale))
  }

  /// From the screen's shorter side: 1080 on current iPhones and iPads.
  static var maxHeight: Int {
    let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
    let native = scene?.screen.nativeBounds.size ?? CGSize(width: 1170, height: 2532)
    let short = min(native.width, native.height)
    return short >= 2160 ? 2160 : short >= 1080 ? 1080 : 720
  }

  static var capabilities: Capabilities {
    .iPhone(maxHeight: maxHeight, decodesHEVC: VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC))
  }

  static func hello() -> Hello {
    Hello(name: name, kind: identity.kind, capabilities: capabilities)
  }
}
