import {evaluateWeeklyPull} from './weekly-schedule.mjs';

// Host contract: claimOccurrence must atomically insert (connectionId, dueDate)
// before any supplier access. A false result means another wake owns this date.
// The host prepares a fresh authenticated KERDOS ticket for each attempt; no
// prior nonce, CSV or supplier credential is stored in this coordinator.
export function createScheduledRunner(host,{clock=()=>new Date()}={}){
 if(!host||typeof host.claimOccurrence!=='function'||typeof host.finishOccurrence!=='function'||typeof host.startRefresh!=='function')throw new TypeError('Invalid scheduled runner host');
 return {
  async tick(connection){
   if(!connection||typeof connection.id!=='string'||!connection.id||!connection.schedule)throw new TypeError('Invalid scheduled connection');
   const decision=evaluateWeeklyPull(connection.schedule,clock(),{
    firstDueDate:connection.firstDueDate,lastHandledDate:connection.lastHandledDate,
    windowMinutes:connection.windowMinutes??30,
   });
   if(decision.state!=='due'&&decision.state!=='missed')return decision;
   const dueDate=decision.localDate;
   const claim=await host.claimOccurrence(connection.id,dueDate,decision.state);
   if(!claim)return {state:'already_handled',localDate:dueDate};
   if(decision.state==='missed'){
    await host.finishOccurrence(connection.id,dueDate,'missed');
    return {state:'missed',localDate:dueDate};
   }
   let result='failed';
   try{
    const outcome=await host.startRefresh(connection);
    if(['saved','up_to_date','verification_needed'].includes(outcome))result=outcome;
   }catch{/* A failed attempt is recorded, never silently retried. */}
   await host.finishOccurrence(connection.id,dueDate,result);
   return {state:result,localDate:dueDate};
  },
 };
}
