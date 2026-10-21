import UIKit
import VideoToolbox
import YoloKit

/// What this Apple TV tells Yolo about itself.
@MainActor
enum ThisDevice {
  /// The approval page's starting name, which the owner can change there.
  static var name: String { UIDevice.current.name }

  /// The TV's current display mode in pixels.
  static var viewport: (width: Int, height: Int) {
    let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
    let size = scene?.screen.currentMode?.size ?? CGSize(width: 1920, height: 1080)
    return (Int(size.width), Int(size.height))
  }

  /// 2160 on an Apple TV 4K on a 4K set.
  static var maxHeight: Int {
    let height = viewport.height
    return height >= 2160 ? 2160 : height >= 1080 ? 1080 : 720
  }

  static var capabilities: Capabilities {
    .appleTV(maxHeight: maxHeight, decodesHEVC: VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC))
  }

  static func hello() -> Hello {
    Hello(name: name, capabilities: capabilities)
  }
}
