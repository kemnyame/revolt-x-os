// Let browser microtasks finish before advancing to the next pending timer.
// Cleared fetch timeouts therefore do not consume virtual network time.
export function virtualClock() {
  let time=0,nextId=0,scheduled=false;
  const timers=new Map();
  function tick(){
    if(scheduled)return;
    scheduled=true;
    setImmediate(()=>{
      scheduled=false;
      const next=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)return;
      timers.delete(next[0]);time=Math.max(time,next[1].at);next[1].callback();
      if(timers.size)tick();
    });
  }
  class ClockDate extends Date {
    constructor(...args){super(...(args.length?args:[time]))}
    static now(){return time}
  }
  return{
    Date:ClockDate,
    setTimeout(callback,delay=0){const id=++nextId;timers.set(id,{callback,at:time+Number(delay)});tick();return id},
    clearTimeout(id){timers.delete(id)},
    advance(milliseconds){time+=milliseconds},
    now:()=>time,
    timerCount:()=>timers.size
  };
}
