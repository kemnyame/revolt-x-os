# Revolt-X Shop

Revolt-X Shop is the multi-shop service commerce module for Revolt-X OS. It is designed for service businesses that need customer-facing booking and sales, work-order execution, products and inventory, payments, finance, and consolidated management across multiple shops.

## Implemented in this build

- Revolt-X OS sign-in and organisation context
- Local Shop role activation layered on Core OS identity
- Multiple shops and branches per organisation
- Customers
- Service catalogue
- Public customer storefront and booking
- Jobs / work orders
- Quick-sale POS and invoices
- Products, stock position and stock movements
- Cash / bank / credit payment posting
- Paystack transaction initialization and verification hooks for MoMo and card
- Payment monitoring
- Expenses and double-entry-style operating ledger
- Finance report summary
- Local immutable audit log
- Responsive management dashboard

## Local setup

```bash
cd apps/shop
cp .env.example .env
npm install
npm run build
npm run dev
```

Required environment:

- `SHOP_DATABASE_URL`
- `CORE_OS_URL`

For online MoMo/card payments also set:

- `PAYSTACK_SECRET_KEY`
- `PUBLIC_BASE_URL`

The Shop module creates its own vertical tables and never writes vertical commerce state into the Core OS database. Core OS remains responsible for organisation identity, users, authentication and base permissions.
