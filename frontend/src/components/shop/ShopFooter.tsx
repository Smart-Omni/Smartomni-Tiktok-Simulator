import { Link } from 'react-router-dom';

export function ShopFooter() {
  return (<footer className="buyer-home-footer">
        <div className="buyer-footer-main">
          <Link to="/" className="buyer-footer-brand"><strong>TikTok</strong><span>SHOP SIMULATOR</span></Link>
          <nav aria-label="Shopping"><h2>Shop</h2><Link to="/">All products</Link><Link to="/cart">Cart</Link><Link to="/account/orders">Orders</Link></nav>
          <nav aria-label="Customer account"><h2>Account</h2><Link to="/login">Sign in</Link><Link to="/account/messages">Messages</Link></nav>
          <nav aria-label="Simulator tools"><h2>Workspace</h2><Link to="/seller-center">Seller Center</Link><Link to="/console">Test Console</Link></nav>
        </div>
        <div className="buyer-footer-bottom"><span>© {new Date().getFullYear()} TikTok SHOP SIMULATOR</span></div>
      </footer>);
}
