# Frontend Integration Guide

The backend API is a drop-in for the frontend's existing **shapes**: `GET /api/v1/products` returns objects matching the `Product` interface in `src/types/index.ts` (price in integer rupees, `colors[].images`, `features[]`, `materials[]`, `inStock`, etc.), and `GET /api/v1/categories` matches the `Category` type. No component prop changes are required for read-only catalog pages.

## What the frontend must change (documented, not silently made)

### 1. Replace static data imports
Every consumer imports helpers from `src/data/products.ts`:

| Frontend today | Backend replacement |
|---|---|
| `getProductsByCategory('sport')` | `GET /api/v1/products?category=sport` |
| `getProductBySlug(slug)` | `GET /api/v1/products/:slug` |
| `getFeaturedProducts()` | `GET /api/v1/products?featured=true` |
| `getNewArrivals()` | `GET /api/v1/products?newArrival=true` |
| `getCategoriesWithProducts(world)` | `GET /api/v1/categories?world=...` (hasProducts computed server-side) |
| `searchProducts(q)` | `GET /api/v1/search?q=...` (min 2 chars, same as the UI) |

Files importing from `src/data/products.ts`: `HomePage`, `SportPage`, `LifestylePage`, `NewFeaturedPage`, `ProductPage`, `SearchOverlay`, `CartDrawer` (via context), `ProductCard`. Recommended: add a small `src/api/client.ts` fetch wrapper (include `credentials: 'include'` for the cart cookie) and optionally React Query for caching/loading states.

### 2. Cart → server-side
`CartContext` currently holds the cart in React state only (lost on refresh). Replace its internals with API calls, keeping the same `useCart()` interface so components don't change:
- `addItem(product, color)` → `POST /api/v1/cart/items` with the chosen **variantId** (pick the variant matching color/size from `product.variants` returned by the API)
- `updateQuantity(productId, qty)` → `PATCH /api/v1/cart/items/:itemId` (note: item id, not product id)
- `removeItem` → `DELETE /api/v1/cart/items/:itemId`
- `items/subtotal` → `GET /api/v1/cart`
- Keep localStorage out; the httpOnly cookie is the identity.

### 3. Checkout
The 3-step form already collects exactly what `POST /api/v1/orders` needs:
`{ email, address: { firstName, lastName, line1: address, line2: apartment, city, state, pincode, phone }, paymentMethod }` — map `paymentMethod: 'card'|'upi'|'cod'` to `CARD|UPI|COD`. After the response, open the provider SDK with `payment.checkoutPayload` (Razorpay Checkout) or call the mock simulator in dev, then poll `GET /api/v1/orders/:orderNumber/status`. The client-computed `shipping` (₹99 under ₹2,000) matches the server rule and should be displayed from `GET /api/v1/cart/quote`.

### 4. Auth UI (does not exist yet — must be added)
Add `/login`, `/register`, and password-reset pages calling `/api/v1/auth/*`. Store the **access token in memory only** (not localStorage); the refresh token is an httpOnly cookie. Add an interceptor that calls `POST /auth/refresh` on 401.

### 5. Account page
Replace the hard-coded `mockOrders` with `GET /api/v1/account/orders`; the response shape matches what the page renders (id → orderNumber, date, status, total, items). Addresses tab → `/api/v1/account/addresses`. Settings tab → `PATCH /api/v1/account`. Wishlist → `GET /api/v1/account/wishlist`.

### 6. Wishlist page
Replace the hard-coded items with `/api/v1/account/wishlist`; heart icons on product pages call `POST/DELETE /api/v1/account/wishlist/:productId`.

### 7. Contact form
`ContactPage.handleSubmit` currently does nothing. POST the form to `/api/v1/contact` with the exact fields it already collects (subject values map 1:1).

### 8. Frontend bugs found during analysis (fix recommended)
- Cart merge key ignores `selectedSize` (two lines with same product+color but different sizes collapse into one). Server cart is keyed by variant, so switching fixes this automatically.
- `WishlistPage` links use item `id` ('1', '2') as a product slug.
- `CheckoutPage` breadcrumb links to `/cart` but no `/cart` route exists (the cart is a drawer).
- `App.tsx` wildcard route renders Home instead of a 404.

## No backend needed (leave as-is)
Static content pages (About, FAQ, Terms, Privacy, Shipping policy, Returns policy, Size guide), the Newsletter (no UI exists — add one and point it at `/api/v1/newsletter/subscribe` when ready), and reviews (no UI yet; API is ready).
