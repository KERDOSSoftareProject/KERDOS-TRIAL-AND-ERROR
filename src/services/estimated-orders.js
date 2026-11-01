import {sameOrderData,validateEstimatedOrder} from '../core/estimated-orders.js';
export function createEstimatedOrderService(backend){
 const supported=!!backend.estimatedOrders;
 const actor=async()=>{if(!supported)throw new Error('Estimated order recording is unavailable');const id=(await backend.session.get())?.user?.id;if(!id)throw new Error('Sign in before recording an order');return id;};
 return {supported,
  async review(organizationId,draft){
   await actor();const r=await backend.estimatedOrders.review(organizationId,draft.id);
   if(r?.kind!=='estimated_order_review'||r.version!==1||r.organizationId!==organizationId||r.draftId!==draft.id||r.vendorId!==draft.vendorId||!sameOrderData(r.estimate,draft.estimate)||r.finalCharge!==null||!Array.isArray(r.requestedLines)||!sameOrderData(r.requestedLines,draft.lines.map(l=>{const n={...l,kind:'estimated_purchase_line_intent',expectedRevision:l.rowRevision,requiresAuthenticatedPersistence:true};delete n.id;delete n.orderId;delete n.rowRevision;return n;}))||!['met','unknown','units_short'].includes(r.deliveryMinimum?.status))throw new Error('Order review differs from the saved draft');return r;
  },
  async submit(review,{confirmed,minimumAcknowledged=false}={}){
   const user=await actor();if(confirmed!==true||review?.kind!=='estimated_order_review'||review.version!==1)throw new Error('Explicitly confirm the reviewed order');
   if(review.deliveryMinimum?.status==='units_short')throw new Error('The stated case minimum is not met');
   if(review.deliveryMinimum?.status==='unknown'&&minimumAcknowledged!==true)throw new Error('Acknowledge the unconfirmed monetary delivery minimum');
   const order=await backend.estimatedOrders.submit(review,minimumAcknowledged);
   validateEstimatedOrder(order,{organizationId:review.organizationId,draftId:review.draftId,review});if(order.submittedBy!==user)throw new Error('Order creator differs from this request');return order;
  },
  async recover(organizationId,draftId){await actor();const order=await backend.estimatedOrders.getByDraft(organizationId,draftId);return order?validateEstimatedOrder(order,{organizationId,draftId}):null;},
 };
}
