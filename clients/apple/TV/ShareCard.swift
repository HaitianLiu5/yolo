import SwiftUI

/// A share link's QR code over the player, for a friend to scan; it plays
/// the item in their browser for 7 days (Agent Note 2026-10-20-share-links).
struct ShareCard: View {
  let link: URL

  var body: some View {
    VStack(spacing: 16) {
      QRCode(text: link.absoluteString)
        .frame(width: 320, height: 320)
        .padding(16)
        .background(.white, in: RoundedRectangle(cornerRadius: 20))
      Text("Scan to watch on your phone").font(.headline)
      Text("The link works for 7 days").font(.caption).foregroundStyle(.secondary)
    }
    .padding(32)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 28))
    .padding(60)
    .allowsHitTesting(false)
  }
}
