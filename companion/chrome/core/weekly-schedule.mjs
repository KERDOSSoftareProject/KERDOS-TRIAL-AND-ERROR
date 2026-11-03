// Portable decision for a client-owned weekly retrieval. The host owns durable
// run records and the clock; this function never starts a vendor session.
const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const datePattern=/^\d{4}-\d{2}-\d{2}$/;

export function evaluateWeeklyPull(schedule,now,{lastAttemptDate=null,windowMinutes=30}={}){
 if(!schedule||!Number.isInteger(schedule.weekday)||schedule.weekday<0||schedule.weekday>6||
   !Number.isInteger(schedule.hour)||schedule.hour<0||schedule.hour>23||
   !Number.isInteger(schedule.minute)||schedule.minute<0||schedule.minute>59||
   typeof schedule.timeZone!=='string'||!schedule.timeZone||
   !Number.isInteger(windowMinutes)||windowMinutes<0||windowMinutes>1440||
   (lastAttemptDate!==null&&(!datePattern.test(lastAttemptDate)||typeof lastAttemptDate!=='string')))
   throw new TypeError('Invalid weekly pull schedule');
 const instant=now instanceof Date?now:new Date(now);
 if(!Number.isFinite(instant.getTime()))throw new TypeError('Invalid clock');
 const formatter=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{
   timeZone:schedule.timeZone,year:'numeric',month:'2-digit',day:'2-digit',
   weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
 });
 const parts=Object.fromEntries(formatter.formatToParts(instant).map(({type,value})=>[type,value]));
 const localDate=`${parts.year}-${parts.month}-${parts.day}`;
 const minuteOfDay=Number(parts.hour)*60+Number(parts.minute);
 const scheduledMinute=schedule.hour*60+schedule.minute;
 const day=weekdays.indexOf(parts.weekday);
 if(day!==schedule.weekday||minuteOfDay<scheduledMinute)return {state:'waiting',localDate};
 if(lastAttemptDate===localDate)return {state:'already_attempted',localDate};
 if(minuteOfDay-scheduledMinute>windowMinutes)return {state:'missed',localDate};
 return {state:'due',localDate};
}
