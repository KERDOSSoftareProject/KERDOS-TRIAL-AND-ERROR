import {exportSelectedMoxeList} from './adapters/moxe.mjs';
// Approved provider metadata. Client/vendor/account/list values are supplied
// per invocation; more adapters can be added without changing the popup runner.
export const providers=Object.freeze([
 Object.freeze({key:'us-foods-moxe',name:'US Foods MOXē',origin:'https://order.usfoods.com',execute:exportSelectedMoxeList}),
]);
