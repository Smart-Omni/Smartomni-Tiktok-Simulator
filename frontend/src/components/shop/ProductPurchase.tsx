import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { toast } from 'sonner';
import { loginUrl } from '@/components/RequireRole';
import { QuantityStepper } from './QuantityStepper';
import { Stars } from './ProductStars';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { MAX_PER_LINE, type CheckoutState } from '@/lib/checkout';
import { getCart, inShop, setCartItem } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import type { ShopRef, Sku } from '@/lib/types';
import { originalPrice, type EnrichedProduct } from '@/mocks';
const soldOut = (s: Sku) => !s.available || s.stock <= 0;

function VariantTiles({ label, skus, value, onChange }: { label: string; skus: Sku[]; value: string | undefined; onChange: (id: string) => void }) {
  const selected = skus.find((sku) => sku.id === value);
  return <div className="detail-variant-picker">
    <div className="detail-variant-heading"><span>{label}</span><strong>{selected?.name ?? 'Out of stock'}</strong></div>
    <RadioGroupPrimitive.Root aria-label={label} value={value} onValueChange={onChange} className="detail-variant-grid">
      {skus.map((sku) => <RadioGroupPrimitive.Item key={sku.id} value={sku.id} disabled={soldOut(sku)} className="detail-variant-option" title={soldOut(sku) ? `${sku.name} — Out of stock` : sku.name}>{sku.name}</RadioGroupPrimitive.Item>)}
    </RadioGroupPrimitive.Root>
  </div>;
}

export function ProductPurchase({ product, shop, quick = false }: { product: EnrichedProduct; shop?: ShopRef; quick?: boolean }) {
  const { buyer } = useAuth();
  const navigate = useNavigate();
  const [skuId, setSkuId] = useState(() => product.skus.find((s) => !soldOut(s))?.id);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const sku = product.skus.find((s) => s.id === skuId);
  const price = sku?.priceVnd ?? product.minPriceVnd;
  const max = sku ? Math.min(sku.stock, MAX_PER_LINE) : 0;

  const pick = (id: string) => {
    setSkuId(id);
    const next = product.skus.find((s) => s.id === id);
    if (next) setQty((q) => Math.max(1, Math.min(q, next.stock, MAX_PER_LINE)));
  };

  /** Adds `qty` on top of what is already in the cart (PUT cart/items sets the quantity). */
  const addToCart = async (): Promise<boolean> => {
    if (!buyer) {
      navigate(loginUrl(productPath({ id: product.id, shop })));
      return false;
    }
    if (!sku || !shop) return false;
    setBusy(true);
    try {
      const seller = inShop(buyer, shop.id);
      const cart = await getCart(seller);
      const inCart = cart.items.find((i) => i.skuId === sku.id)?.quantity ?? 0;
      await setCartItem(seller, sku.id, Math.min(MAX_PER_LINE, inCart + qty));
      window.dispatchEvent(new Event('shop-cart-updated'));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-buybox">
      <h1>{product.title}</h1>
      <p className="detail-rating"><Stars value={product.rating} /><span>{product.rating.toFixed(1)} / 5</span></p>
      <div className="detail-price-row">
        {product.discountPct > 0 ? <span className="rounded bg-buyer-soft px-1.5 text-sm font-bold text-buyer">-{product.discountPct}%</span> : null}
        <span className="detail-price" data-testid="price">
          {shopPrice(price)}
        </span>
        {product.discountPct > 0 ? <span className="text-sm text-muted-2 line-through">{shopPrice(originalPrice(price, product.discountPct))}</span> : null}
      </div>
      {shop && !quick ? (
        <div className="detail-shop-chat">
            <Link to={buyer ? `/account/messages?shop=${encodeURIComponent(shop.id)}` : loginUrl(shop.id ? `/account/messages?shop=${encodeURIComponent(shop.id)}` : '/account/messages')}>
              <MessageCircle size={15} aria-hidden="true" />Chat with shop
            </Link>
        </div>
      ) : null}

      <VariantTiles label={product.skus[0]?.attributeName || 'Variant'} skus={product.skus} value={skuId} onChange={pick} />

      <div className="detail-quantity">
        <span className="text-sm font-semibold">Quantity</span>
        <div className="flex items-center gap-3">
          <QuantityStepper value={qty} max={max} onChange={setQty} className="detail-quantity-stepper !rounded-md" />
          <span className="detail-stock">{sku ? `${sku.stock} available` : 'Out of stock'}</span>
        </div>
      </div>

      <div className={`detail-purchase-actions${quick ? ' detail-quick-actions' : ''}`}>
        {!quick && <Button
          size="lg"
          className="detail-buy-now !bg-[#171717] !text-white hover:!bg-[#333333]"
          disabled={!sku || busy}
          onClick={async () => {
            if (sku && shop && (await addToCart())) navigate('/checkout', { state: { items: [{ shopId: shop.id, skuId: sku.id, quantity: qty }] } satisfies CheckoutState });
          }}
        >
          Buy now
        </Button>}
        <Button
          size="lg"
          variant="outline"
          className="detail-add-cart !bg-white !text-[#222222] hover:!bg-[#f7f7f7]"
          disabled={!sku || busy}
          onClick={async () => {
            if (await addToCart()) toast.success('Added to cart', { duration: 2500, className: 'shop-cart-toast' });
          }}
        >
          Add to cart
        </Button>
      </div>
    </div>
  );
}

