import {reconcileInvoice} from '../core/invoice-reconciliation.js';
export function createInvoiceReconciliationService(backend){return {supported:!!backend.invoiceReconciliation,
 async review(organizationId,invoiceId){if(!backend.invoiceReconciliation)throw new Error('Invoice reconciliation is unavailable');if(!(await backend.session.get())?.user?.id)throw new Error('Sign in to review invoice reconciliation');return reconcileInvoice(await backend.invoiceReconciliation.review(organizationId,invoiceId),{organizationId,invoiceId});},
};}
