import UIKit
import WebKit
import Capacitor

/**
 * The iOS side of v1.4's scroll containment, and the only part of it CSS cannot reach.
 *
 * The owner's report — *"i should not be able to scroll the top bar of the main app such that it
 * takes up more space"* — is not only a layout question on iOS. The web content is drawn inside the
 * WKWebView's own `UIScrollView`, and that scroll view bounces: with `alwaysBounceVertical` on (the
 * WebKit default) a vertical drag moves the entire page — top bar included — even when the document
 * itself has nothing to scroll, so the header can be pulled down into view and the space above it
 * revealed. No CSS value can switch that off; it is the scroll view's `bounces` flag.
 *
 * v1.4 makes the document a fixed shell in CSS (`html, body { overflow: hidden }`) so there is
 * nothing to scroll and nothing for a gesture over the now-playing screen to chain into. Turning
 * bouncing off here removes the last way the page as a whole can move, which is what makes "the top
 * bar cannot grow or scroll away" true on the phone as well as in a browser.
 *
 * Everything else is the stock Capacitor behaviour: this subclass only replaces the web view
 * factory, and the bridge, plugins, keyboard handling and lifecycle are untouched.
 */
class ViewController: CAPBridgeViewController {
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = super.webView(with: frame, configuration: configuration)
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        return webView
    }
}
