import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { RequireRole } from './components/RequireRole';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { SessionExpiryWatcher } from './components/SessionExpiryWatcher';
import { LegacyLayout } from './layouts/LegacyLayout';
import { ShopLayout } from './layouts/ShopLayout';
import { AuthProvider } from './lib/auth';
import { LoginPage } from './pages/LoginPage';
import { CartPage } from './pages/shop/CartPage';
import { CheckoutPage } from './pages/shop/CheckoutPage';
import { MessagesPage } from './pages/shop/MessagesPage';
import { HomePage } from './pages/shop/HomePage';
import { OrdersPage } from './pages/shop/OrdersPage';
import { ProductPage } from './pages/shop/ProductPage';
import { ShopPage } from './pages/shop/ShopPage';

/** Code-split: Seller Center, the Test Console and the consent page load on first visit, outside the main bundle. */
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const SellerLayout = named(() => import('./layouts/SellerLayout'), 'SellerLayout');
const SellerHome = named(() => import('./pages/seller-center/SellerHome'), 'SellerHome');
const SellerShop = named(() => import('./pages/seller-center/SellerShop'), 'SellerShop');
const SellerOrders = named(() => import('./pages/seller-center/SellerOrders'), 'SellerOrders');
const SellerOrderDetail = named(() => import('./pages/seller-center/SellerOrderDetail'), 'SellerOrderDetail');
const SellerReturns = named(() => import('./pages/seller-center/SellerReturns'), 'SellerReturns');
const SellerProducts = named(() => import('./pages/seller-center/SellerProducts'), 'SellerProducts');
const SellerProductForm = named(() => import('./pages/seller-center/SellerProductForm'), 'SellerProductForm');
const SellerVouchers = named(() => import('./pages/seller-center/SellerVouchers'), 'SellerVouchers');
const SellerMessages = named(() => import('./pages/seller-center/SellerMessages'), 'SellerMessages');
const SellerCustomers = named(() => import('./pages/seller-center/SellerCustomers'), 'SellerCustomers');
const SellerTestingIntegration = named(() => import('./pages/seller-center/SellerTesting'), 'SellerTestingIntegration');
const SellerTestingSystem = named(() => import('./pages/seller-center/SellerTesting'), 'SellerTestingSystem');
const ConsolePage = named(() => import('./pages/ConsolePage'), 'ConsolePage');
const AuthorizePage = named(() => import('./pages/AuthorizePage'), 'AuthorizePage');

/** A lazy page with its own loading state, so the surrounding layout stays on screen. */
const page = (Page: LazyExoticComponent<ComponentType>) => (
  <Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">Loading…</p>}>
    <Page />
  </Suspense>
);

/** Old marketplace product links (/buyer/product/<id>, e.g. from SmartOmni) open the new product page. */
function LegacyProductLink() {
  const { id = '' } = useParams();
  return <Navigate to={`/product/${encodeURIComponent(id)}`} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <TooltipProvider>
        <Routes>
          {/* TikTok Shop (buyer) */}
          <Route element={<ShopLayout />}>
            <Route index element={<HomePage />} />
            <Route path="product/:shopId/:id" element={<ProductPage />} />
            <Route path="shop/:shopId" element={<ShopPage />} />
            <Route path="product/:id" element={<ProductPage />} />
            <Route element={<RequireRole role="BUYER" />}>
              <Route path="cart" element={<CartPage />} />
              <Route path="checkout" element={<CheckoutPage />} />
              <Route path="account/orders" element={<OrdersPage />} />
              <Route path="account/messages" element={<MessagesPage />} />
            </Route>
          </Route>
          <Route path="login" element={<LoginPage />} />

          {/* Seller Center */}
          <Route
            path="seller-center"
            element={
              <RequireRole role="SELLER">{page(SellerLayout)}</RequireRole>
            }
          >
            <Route index element={page(SellerHome)} />
            <Route path="orders" element={page(SellerOrders)} />
            <Route path="orders/:id" element={page(SellerOrderDetail)} />
            <Route path="returns" element={page(SellerReturns)} />
            <Route path="products" element={page(SellerProducts)} />
            <Route path="products/new" element={page(SellerProductForm)} />
            <Route path="products/:id/edit" element={page(SellerProductForm)} />
            <Route path="vouchers" element={page(SellerVouchers)} />
            <Route path="messages" element={page(SellerMessages)} />
            <Route path="customers" element={page(SellerCustomers)} />
            <Route path="shop" element={page(SellerShop)} />
            <Route path="testing/integration" element={page(SellerTestingIntegration)} />
            <Route path="testing/system" element={page(SellerTestingSystem)} />
          </Route>

          {/* links to the removed /buyer and /seller pages */}
          <Route path="buyer/product/:id" element={<LegacyProductLink />} />
          <Route path="buyer/*" element={<Navigate to="/" replace />} />
          <Route path="seller/*" element={<Navigate to="/seller-center" replace />} />

          {/* Test Console and the OAuth consent page keep the simulator layout */}
          <Route element={<LegacyLayout />}>
            <Route path="seller/authorize" element={page(AuthorizePage)} />
            <Route path="console/*" element={page(ConsolePage)} />
            <Route path="*" element={<div className="state state-empty">Page not found.</div>} />
          </Route>
        </Routes>
        <SessionExpiryWatcher />
        <Toaster position="top-center" />
      </TooltipProvider>
    </AuthProvider>
  );
}
