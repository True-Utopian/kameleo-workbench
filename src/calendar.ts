import { CronExpressionParser } from 'cron-parser';
const invalid=(message:string)=>Object.assign(new Error(message),{statusCode:400});

/** Five-field, minute-resolution cron. All persisted occurrences are UTC instants. */
export function calendarOccurrences(cron: unknown, timezone: unknown, after: number, count = 5): number[] {
  if(typeof cron!=='string'||cron.length>160||cron.trim().split(/\s+/).length!==5)throw invalid('Use a five-field cron rule: minute hour day month weekday');
  if(/(^|\s|,)H(?:\(|\/|,|\s|$)/i.test(cron))throw invalid('Hashed cron fields are not supported; choose explicit minutes and hours');
  if(typeof timezone!=='string'||!timezone||timezone.length>120)throw invalid('Choose an IANA timezone such as Europe/London or UTC');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw invalid('Invalid schedule timezone');}
  if(!Number.isSafeInteger(after)||after<0||after>=8640000000000000||!Number.isInteger(count)||count<1||count>5)throw invalid('Invalid calendar preview time or count');
  try{
    const expression=CronExpressionParser.parse(cron.trim(),{currentDate:after,tz:timezone});
    const dates=expression.take(count).map(date=>date.getTime());
    if(dates.length!==count||dates.some(time=>!Number.isSafeInteger(time)||time<=after))throw new Error('No next occurrence');
    return dates;
  }catch{throw invalid('Invalid cron rule or no future occurrence within the supported date range');}
}
