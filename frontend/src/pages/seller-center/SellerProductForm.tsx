import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, ImagePlus, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Loaded, NativeSelect, SellerCard } from '@/components/seller/SellerUi';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { createProduct, getBrands, getCatalog, getCategories, getCategoryAttributes, getCategoryRules, patchProduct, uploadProductImage } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import {
  attributeValuesOf,
  categoryPath,
  imageFileProblem,
  leafOptions,
  listingBody,
  MAX_IMAGES,
  move,
  reconcileAttributes,
  splitValues,
  validateProductForm,
  type AttributeValues,
  type FormErrors,
} from '@/lib/productForm';
import type { Brand, CatalogProduct, CategoryAttribute, CategoryNode, CategoryRules, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { isWholeVnd } from './SellerProducts';

interface ImageSlot {
  key: string;
  status: 'uploading' | 'done' | 'error';
  /** Server uri once uploaded. */
  uri?: string;
  /** Uploaded URL, or a local object URL while uploading. */
  src: string;
  error?: string;
}

interface Variant {
  sellerSku: string;
  name: string;
  price: string;
}

let slotSeq = 0;
const nextKey = () => `img-${++slotSeq}`;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SellerCard label={title} className="seller-listing-section">
      <div className="seller-listing-section-heading"><h2>{title}</h2></div>
      <div className="seller-listing-section-body">
      {children}
      </div>
    </SellerCard>
  );
}

function ImagesField({ seller, slots, setSlots, error }: { seller: DemoSession; slots: ImageSlot[]; setSlots: React.Dispatch<React.SetStateAction<ImageSlot[]>>; error?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const add = (files: File[]) => {
    const room = MAX_IMAGES - slots.length;
    if (files.length > room) toast.error(`At most ${MAX_IMAGES} images; ${files.length - Math.max(room, 0)} not added`);
    for (const file of files.slice(0, Math.max(room, 0))) {
      const key = nextKey();
      const problem = imageFileProblem(file);
      const src = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
      if (problem) {
        setSlots((s) => [...s, { key, status: 'error', src, error: problem }]);
        continue;
      }
      setSlots((s) => [...s, { key, status: 'uploading', src }]);
      uploadProductImage(seller, file).then(
        (img) => setSlots((s) => s.map((x) => (x.key === key ? { key, status: 'done', uri: img.uri, src: img.url } : x))),
        (e: Error) => setSlots((s) => s.map((x) => (x.key === key ? { ...x, status: 'error', error: `${file.name}: ${e.message}` } : x))),
      );
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    add([...e.dataTransfer.files]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="seller-listing-images" role="list" aria-label="Product images">
        {slots.map((s, i) => (
          <div key={s.key} role="listitem" aria-label={`Image ${i + 1}${i === 0 ? ' (main)' : ''}`} className={cn('relative flex size-28 flex-col overflow-hidden rounded-lg ring-1', s.status === 'error' ? 'ring-destructive' : 'ring-line-soft')}>
            {s.src ? <img src={s.src} alt={`Product image ${i + 1}`} className="size-full object-cover" /> : <div className="size-full bg-surface" />}
            {i === 0 && s.status !== 'error' ? <span className="absolute left-1 top-1 rounded bg-teal px-1.5 text-[10px] font-semibold text-white">Main</span> : null}
            {s.status === 'uploading' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-white/70" role="status" aria-label="Uploading">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : null}
            {s.status === 'error' ? <div className="absolute inset-x-0 bottom-6 bg-destructive/90 px-1 text-[10px] text-white">Upload failed</div> : null}
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/40 text-white">
              <button type="button" aria-label={`Move image ${i + 1} left`} disabled={i === 0} className="px-1 disabled:opacity-30" onClick={() => setSlots((x) => move(x, i, i - 1))}>
                <ChevronLeft className="size-4" />
              </button>
              <button type="button" aria-label={`Remove image ${i + 1}`} className="px-1" onClick={() => setSlots((x) => x.filter((y) => y.key !== s.key))}>
                <Trash2 className="size-4" />
              </button>
              <button type="button" aria-label={`Move image ${i + 1} right`} disabled={i === slots.length - 1} className="px-1 disabled:opacity-30" onClick={() => setSlots((x) => move(x, i, i + 1))}>
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
        ))}
        {slots.length < MAX_IMAGES ? (
          <button
            type="button"
            aria-label="Add images"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn('flex size-28 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-muted-foreground', dragging ? 'border-teal bg-teal-soft' : 'border-line-soft')}
          >
            <ImagePlus className="size-5" />
            Add images
            <span>
              {slots.length}/{MAX_IMAGES}
            </span>
          </button>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        data-testid="image-input"
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {slots
        .filter((s) => s.status === 'error')
        .map((s) => (
          <p key={s.key} className="text-xs text-destructive">
            {s.error}
          </p>
        ))}
      <span className="seller-listing-file-limits">JPEG / PNG / WebP · 5 MB</span>
      <FieldError id="images-error" message={error} />
    </div>
  );
}

function CategoryField({ tree, value, onChange, error }: { tree: CategoryNode[]; value: string; onChange: (id: string) => void; error?: string }) {
  const [search, setSearch] = useState('');
  const leaves = useMemo(() => leafOptions(tree), [tree]);
  const path = categoryPath(tree, value);
  const levels: CategoryNode[][] = [tree];
  for (const n of path) if (n.children.length) levels.push(n.children);
  const q = search.trim().toLowerCase();
  const matches = q ? leaves.filter((l) => l.path.toLowerCase().includes(q)).slice(0, 20) : [];

  return (
    <div className="flex flex-col gap-3">
      <Input aria-label="Search categories" placeholder="Search a category by name" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-md" />
      {q ? (
        <ul aria-label="Matching categories" className="max-h-56 max-w-xl overflow-y-auto rounded-md ring-1 ring-line-soft">
          {matches.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">No category matches.</li> : null}
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
                onClick={() => {
                  onChange(m.id);
                  setSearch('');
                }}
              >
                {m.path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {levels.map((nodes, depth) => (
          <NativeSelect
            key={depth}
            aria-label={`Category level ${depth + 1}`}
            value={path[depth]?.id ?? ''}
            onChange={(e) => onChange(e.target.value || (path[depth - 1]?.id ?? ''))}
            className="h-9 min-w-48"
          >
            <option value="">Select…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.isLeaf ? '' : ' ›'}
              </option>
            ))}
          </NativeSelect>
        ))}
      </div>
      {path.length ? <p className="text-sm">Selected: {path.map((n) => n.name).join(' > ')}</p> : null}
      <FieldError id="category-error" message={error} />
    </div>
  );
}

function AttributeInput({ attr, value, onChange }: { attr: CategoryAttribute; value: string[]; onChange: (v: string[]) => void }) {
  const label = `${attr.name}${attr.isRequired ? ' *' : ''}`;
  const id = `attr-${attr.id}`;
  if (!attr.isCustomizable && attr.isMultipleSelection) {
    return (
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{label}</legend>
        <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
          {attr.values.map((v) => (
            <label key={v.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={value.includes(v.name)} onChange={(e) => onChange(e.target.checked ? [...value, v.name] : value.filter((x) => x !== v.name))} />
              {v.name}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (!attr.isCustomizable) {
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <NativeSelect id={id} value={value[0] ?? ''} onChange={(e) => onChange(e.target.value ? [e.target.value] : [])} className="h-9">
          <option value="">Select…</option>
          {attr.values.map((v) => (
            <option key={v.id} value={v.name}>
              {v.name}
            </option>
          ))}
        </NativeSelect>
      </div>
    );
  }
  const listId = attr.values.length ? `${id}-options` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        list={listId}
        placeholder={attr.isMultipleSelection ? 'Values separated by commas' : attr.values.length ? 'Pick or type a value' : 'Type a value'}
        value={value.join(', ')}
        onChange={(e) => onChange(attr.isMultipleSelection ? splitValues(e.target.value) : e.target.value.trim() ? [e.target.value] : [])}
      />
      {listId ? (
        <datalist id={listId}>
          {attr.values.map((v) => (
            <option key={v.id} value={v.name} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

function ProductForm({ seller, product }: { seller: DemoSession; product?: CatalogProduct }) {
  const navigate = useNavigate();
  const editing = Boolean(product);
  const categories = useAsync(() => getCategories(seller), [seller.sessionToken]);
  const brands = useAsync(() => getBrands(seller), [seller.sessionToken]);

  const [title, setTitle] = useState(product?.title ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [slots, setSlots] = useState<ImageSlot[]>(() => (product?.images ?? []).map((i) => ({ key: nextKey(), status: 'done', uri: i.uri, src: i.url })));
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [brandId, setBrandId] = useState(product?.brandId ?? '');
  const [attrValues, setAttrValues] = useState<AttributeValues>(() => (product ? attributeValuesOf(product) : {}));
  const [weightKg, setWeightKg] = useState(product?.packageWeight ? String(product.packageWeight.value) : '');
  const [dims, setDims] = useState({
    length: product?.packageDimensions ? String(product.packageDimensions.length) : '',
    width: product?.packageDimensions ? String(product.packageDimensions.width) : '',
    height: product?.packageDimensions ? String(product.packageDimensions.height) : '',
  });
  const [variants, setVariants] = useState<Variant[]>([{ sellerSku: '', name: '', price: '' }]);
  const [attributes, setAttributes] = useState<CategoryAttribute[]>([]);
  const [rules, setRules] = useState<CategoryRules>();
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string>();

  const tree = categories.data?.categories ?? [];
  const leaf = categoryPath(tree, categoryId).at(-1)?.isLeaf === true;

  // Load the attributes and rules of the chosen leaf; values that do not fit the new category are dropped.
  useEffect(() => {
    let live = true;
    if (!categoryId || !leaf) {
      setAttributes([]);
      setRules(undefined);
      return;
    }
    Promise.all([getCategoryAttributes(seller, categoryId), getCategoryRules(seller, categoryId)]).then(
      ([a, r]) => {
        if (!live) return;
        setAttributes(a.attributes);
        setRules(r);
        setAttrValues((v) => reconcileAttributes(v, a.attributes));
      },
      (e: Error) => live && toast.error(`Could not load the category attributes: ${e.message}`),
    );
    return () => {
      live = false;
    };
  }, [seller, categoryId, leaf]);

  const state = {
    title,
    description,
    imageUris: slots.filter((s) => s.status === 'done' && s.uri).map((s) => s.uri!),
    pendingImages: slots.filter((s) => s.status !== 'done').length,
    categoryId,
    brandId,
    attributes: attrValues,
    weightKg,
    ...dims,
  };
  const errors: FormErrors = validateProductForm(state, leaf, attributes, rules);
  const variantErrors = editing ? [] : variants.map((v) => (!v.sellerSku.trim() || !v.name.trim() ? 'Enter a seller SKU and a variant name' : !isWholeVnd(v.price) ? 'Enter a whole VND price' : undefined));
  const valid = Object.keys(errors).length === 0 && variantErrors.every((e) => !e);
  const shown = (e?: string) => (touched ? e : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setServerError(undefined);
    if (!valid) return;
    setBusy(true);
    const listing = listingBody(state, attributes);
    try {
      if (product) {
        await patchProduct(seller, product.id, { title: title.trim(), description, ...listing });
        toast.success('Product saved');
      } else {
        await createProduct(seller, { title: title.trim(), description, ...listing, skus: variants.map((v) => ({ sellerSku: v.sellerSku.trim(), name: v.name.trim(), priceVnd: Number(v.price) })) });
        toast.success('Product created');
      }
      navigate('/seller-center/products');
    } catch (err) {
      setServerError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="seller-listing-form" aria-label={editing ? 'Edit product' : 'New product'}>
      <div className="seller-listing-actions">
        <Button asChild variant="outline" size="icon">
          <Link to="/seller-center/products">
            <ArrowLeft aria-hidden="true" /><span className="sr-only">Back to products</span>
          </Link>
        </Button>
        {product ? <span className="font-mono text-xs text-muted-foreground">#{product.externalId}</span> : null}
        <div className="seller-listing-save">
          <Button asChild type="button" variant="outline"><Link to="/seller-center/products">Cancel</Link></Button>
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save size={14} />}{editing ? 'Save product' : 'Create product'}</Button>
        </div>
      </div>

      <div className="seller-listing-grid">
      <div className="seller-listing-main">
      <Section title="Basic info">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-title">Title *</Label>
          <Input id="product-title" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} aria-invalid={Boolean(shown(errors.title))} />
          <FieldError id="title-error" message={shown(errors.title)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-description">Description</Label>
          <Textarea id="product-description" rows={5} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </Section>

      <Section title="Images *">
        <ImagesField seller={seller} slots={slots} setSlots={setSlots} error={shown(errors.images)} />
      </Section>

      <Section title="Variants">
        {product ? (
          <ul className="seller-listing-existing-skus">
            {product.skus.map((s) => (
              <li key={s.id}>
                <div><strong>{s.sellerSku}</strong><span>{s.name}</span></div><strong>{shopPrice(s.priceVnd)}</strong><span>{s.totalStock} in stock</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-2">
            {variants.map((v, i) => (
              <div key={i} className="seller-listing-variant" aria-label={`Variant ${i + 1}`} role="group">
                <label><span>Seller SKU *</span>
                <Input aria-label={`Seller SKU ${i + 1}`} placeholder="Seller SKU" value={v.sellerSku} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, sellerSku: e.target.value } : x)))} className="h-8 w-40" />
                </label><label><span>Variant *</span>
                <Input aria-label={`Variant name ${i + 1}`} placeholder="Variant" value={v.name} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="h-8 w-40" />
                </label><label><span>Price (VND) *</span>
                <Input aria-label={`Price ${i + 1}`} placeholder="Price VND" inputMode="numeric" value={v.price} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} className="h-8 w-32" />
                </label>
                {variants.length > 1 ? (
                  <Button type="button" size="icon" variant="ghost" aria-label={`Remove variant ${i + 1}`} onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                    <X />
                  </Button>
                ) : null}
                {touched && variantErrors[i] ? <span className="seller-listing-variant-error text-xs text-destructive">{variantErrors[i]}</span> : null}
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setVariants([...variants, { sellerSku: '', name: '', price: '' }])}>
              <Plus /> Add variant
            </Button>
          </div>
        )}
      </Section>

      </div>
      <div className="seller-listing-aside">
      <Section title="Category *">
        <Loaded result={categories} what="categories">
          {() => <CategoryField tree={tree} value={categoryId} onChange={setCategoryId} error={shown(errors.category)} />}
        </Loaded>
      </Section>

      <Section title="Brand">
        <Loaded result={brands} what="brands">
          {(d) => (
            <NativeSelect aria-label="Brand" value={brandId} onChange={(e) => setBrandId(e.target.value)} className="h-9 w-64">
              <option value="">No brand selected</option>
              {d.brands.map((b: Brand) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.authorized ? '' : ' (not authorized)'}
                </option>
              ))}
            </NativeSelect>
          )}
        </Loaded>
      </Section>

      <Section title="Attributes">
        {!leaf ? <p className="text-sm text-muted-foreground">Select a category first.</p> : null}
        {leaf && attributes.length === 0 ? <p className="text-sm text-muted-foreground">This category has no attributes.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {attributes.map((a) => (
            <div key={a.id} className="flex flex-col gap-1">
              <AttributeInput attr={a} value={attrValues[a.id] ?? []} onChange={(v) => setAttrValues({ ...attrValues, [a.id]: v })} />
              <FieldError id={`attr-${a.id}-error`} message={shown(errors[`attr:${a.id}`])} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Shipping">
        <div className="seller-listing-shipping">
          <div className="flex flex-col gap-1">
            <Label htmlFor="package-weight">Weight (kg)</Label>
            <Input id="package-weight" inputMode="decimal" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className="w-32" />
          </div>
          {(['length', 'width', 'height'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <Label htmlFor={`package-${k}`}>
                {k.charAt(0).toUpperCase() + k.slice(1)} (cm){rules?.packageDimensionsRequired ? ' *' : ''}
              </Label>
              <Input id={`package-${k}`} inputMode="decimal" value={dims[k]} onChange={(e) => setDims({ ...dims, [k]: e.target.value })} className="w-28" />
            </div>
          ))}
        </div>
        <FieldError id="weight-error" message={shown(errors.weight)} />
        <FieldError id="dimensions-error" message={shown(errors.dimensions)} />
      </Section>

      </div>
      </div>

      {serverError ? (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}
      {touched && !valid ? <p className="text-sm text-destructive">Fix the highlighted fields before saving.</p> : null}
    </form>
  );
}

export function SellerProductForm() {
  const { seller } = useAuth();
  const { id } = useParams();
  const catalog = useAsync(() => (seller ? getCatalog(seller) : Promise.reject(new Error('Not signed in'))), [seller?.sessionToken, seller?.shopId]);
  if (!seller) return null;
  return (
    <Loaded result={catalog} what="the product">
      {(d) => {
        const product = id ? d.items.find((p) => p.id === id) : undefined;
        if (id && (!product || product.status === 'DELETED')) {
          return (
            <SellerCard className="py-12 text-center text-sm text-muted-foreground">
              This product does not exist or was deleted. <Link to="/seller-center/products" className="text-teal underline">Back to products</Link>
            </SellerCard>
          );
        }
        return <ProductForm key={product?.id ?? 'new'} seller={seller} product={product} />;
      }}
    </Loaded>
  );
}
