// Portable decision for a client-owned weekly retrieval. The host owns durable
// run records and the clock; this function never starts a vendor session.
// firstDueDate is the first eligible local scheduled day after enrollment.
// The host must atomically mark lastHandledDate before starting a retrieval or
// recording a missed occurrence, so crashes and repeated clock hours cannot
// launch an untracked second attempt.
const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const dayMs=86400000;
const dateValue=value=>{
 if(typeof value!=='string'||!datePattern.test(value))throw new TypeError('Invalid schedule date');
 const stamp=Date.parse(value+'T00:00:00Z');
 if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==value)throw new TypeError('Invalid schedule date');
 return stamp;
};

export function evaluateWeeklyPull(schedule,now,{firstDueDate,lastHandledDate=null,windowMinutes=30}={}){
 if(!schedule||!Number.isInteger(schedule.weekday)||schedule.weekday<0||schedule.weekday>6||
   !Number.isInteger(schedule.hour)||schedule.hour<0||schedule.hour>23||
   !Number.isInteger(schedule.minute)||schedule.minute<0||schedule.minute>59||
   typeof schedule.timeZone!=='string'||!schedule.timeZone||
   !Number.isInteger(windowMinutes)||windowMinutes<0||windowMinutes>1440||
   schedule.hour*60+schedule.minute+windowMinutes>=1440)
   throw new TypeError('Invalid weekly pull schedule');
 const first=dateValue(firstDueDate);
 if(new Date(first).getUTCDay()!==schedule.weekday)throw new TypeError('First due date has the wrong weekday');
 const handled=lastHandledDate===null?null:dateValue(lastHandledDate);
 if(handled!==null&&handled<first)throw new TypeError('Handled date predates the schedule');
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
 const today=dateValue(localDate);
 const elapsedDays=(day-schedule.weekday+7)%7;
 let latest=today-elapsedDays*dayMs;
 if(elapsedDays===0&&minuteOfDay<scheduledMinute)latest-=7*dayMs;
 if(latest<first)return {state:'waiting',localDate};
 if(handled!==null&&handled>today)throw new TypeError('Handled date is in the future');
 const dueDate=new Date(latest).toISOString().slice(0,10);
 if(handled!==null&&handled>=latest)return {state:latest===today?'already_handled':'waiting',localDate};
 if(latest===today&&minuteOfDay-scheduledMinute<=windowMinutes)return {state:'due',localDate};
 return {state:'missed',localDate:dueDate};
}
