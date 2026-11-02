import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// A QR code drawn crisp at any size: one pixel per module, scaled without
/// smoothing.
struct QRCode: View {
  let text: String

  var body: some View {
    if let image = Self.image(for: text) {
      Image(decorative: image, scale: 1)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
    } else {
      Color.clear
    }
  }

  static func image(for text: String) -> CGImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    // A four-module quiet zone, as scanners expect.
    let padded = output.transformed(by: CGAffineTransform(translationX: 4, y: 4))
      .composited(over: CIImage(color: .white).cropped(to: output.extent.insetBy(dx: -4, dy: -4).offsetBy(dx: 4, dy: 4)))
    return CIContext().createCGImage(padded, from: padded.extent)
  }
}
