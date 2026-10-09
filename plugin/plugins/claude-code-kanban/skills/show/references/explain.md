# Explain card

A markdown card that shows how code works: what calls what, what a function decides, where things live, or what a change moves. Post `kind: "markdown"`; the board renders the fences below.

## Make one point

Each card makes one point about the code under discussion. Write the point as a sentence or two, then the view that proves it. Pick the smallest view that makes the point clear; add a second view to the card only when it shows what the first cannot.

| Showing | View | Fence |
|---|---|---|
| Runtime flow: who calls whom | Call stack | `callstack` |
| What a function decides | Pseudocode | `text` |
| UI structure, state and module boundaries | Component tree | `tsx` |
| Which file owns what | File tree | `text` |
| Messages between parts over time | Sequence | `mermaid` |
| What a change adds, removes or moves | A diff of the view above | see [Diff](#diff) |

Keep only the calls, files, props and states the point needs, with real names from the code. Give the card a `key` that names the topic; post a follow-up view, such as the diff after the fix, with the same key so it replaces the card.

## Call stack

The board draws the tree lines, links, focus and folds from this notation:

```callstack
 handleCheckout                  src/routes/checkout.ts:24
   validateCart                  throws on an empty cart
   placeOrder *                  src/orders/place.ts:40
     chargeCard                  src/payments/charge.ts:31
       ~ 2 SDK frames
         PaymentsClient.charge   node_modules/pay-sdk/client.js:112
         HttpClient.request      node_modules/pay-sdk/http.js:58
+    sendReceipt                 src/email/receipt.ts:9
-    logOrder                    src/orders/log.ts:5
 onPaymentWebhook                src/routes/webhooks.ts:58
   markOrderPaid                 src/orders/status.ts:22
```

- The fence tag is `callstack`.
- Caller on top. Indent each callee 2 spaces under its caller; the board turns the spaces into tree lines. Several roots are fine.
- One frame per line: the function or method name as one identifier, spelled as in the code.
- The note goes after 2 or more spaces: a `path:line` relative to the project root, which the board links, or a few words. Line the notes up in one column.
- A `*` after the name, with one space, marks the frame to look at. One per stack.
- `+` or `-` in the first column marks a frame the change adds or removes. In a stack with any `+` or `-`, every other line starts with one space.

### Folds

A `~ N <what> frames` line stands for frames the reader can skip, such as framework, library or runtime code. It sits where those frames sit: under the frame that calls them, or at the top for framework callers above a handler.

- With frames indented under it, the line is a fold: the board shows it closed, and the reader clicks it to open.
- A fold that holds the `*` frame or a `+` or `-` frame starts open, so the point stays on screen.
- Folds nest: library frames that call runtime frames get a `~` each.
- With nothing under it, the line is a note that frames were left out. Write the frames out only when the reader may need them.

## Pseudocode

```text
placeOrder(cart)
  if any item is out of stock
    return "sold out"
  charge the card
  if the charge fails
    release the stock
  send the receipt
```

## Component tree

```tsx
<CheckoutPage>             (src/routes/checkout.tsx)
  useCart()
  <OrderSummary>
    <PayButton>            (packages/ui)
```

## File tree

The one view drawn with box characters:

```text
src/
├── routes/       # HTTP handlers
├── orders/       # owns order state
└── payments/     # talks to the card provider
```

## Diff

Draw a change in the shape of the view it changes: a component tree diff for a component change, a file tree diff for a move. Mark each line with `+`, `-` or a space in the first column. A call stack takes the marks inside its `callstack` fence; every other view goes in a `diff` fence:

```diff
 <CheckoutPage>
   useCart()
   <OrderSummary>
+    <PromoCodeInput />
     <PayButton>
```

Show the whole block without marks when most of it is new, or when a diff would hide the order or the owner of each part.
