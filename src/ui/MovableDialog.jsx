import {Children,cloneElement,useCallback,useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";

// Portal avoids page and table layout affecting viewport positioning.
export function MovableDialog({children,label="Dialog",maxWidth=600,zIndex=1000}) {
  const panel=useRef(null),drag=useRef(null);
  const [offset,setOffset]=useState({x:0,y:0});
  const constrain=useCallback((next,current)=>{
    const rect=panel.current?.getBoundingClientRect();
    if(!rect)return next;
    const view=window.visualViewport;
    const left=(view?.offsetLeft||0)+16,top=(view?.offsetTop||0)+16;
    const right=left+(view?.width||window.innerWidth)-32;
    const bottom=top+(view?.height||window.innerHeight)-32;
    return {
      x:Math.max(left-rect.left+current.x,Math.min(right-rect.right+current.x,next.x)),
      y:Math.max(top-rect.top+current.y,Math.min(bottom-rect.bottom+current.y,next.y)),
    };
  },[]);
  const move=useCallback(next=>setOffset(current=>constrain(next,current)),[constrain]);
  useEffect(()=>{
    if(typeof document==="undefined")return;
    const previous=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const fit=()=>setOffset(current=>constrain(current,current));
    window.addEventListener("resize",fit);
    window.visualViewport?.addEventListener("resize",fit);
    window.visualViewport?.addEventListener("scroll",fit);
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(fit):null;
    if(panel.current)observer?.observe(panel.current);
    return ()=>{
      document.body.style.overflow=previous;
      window.removeEventListener("resize",fit);
      window.visualViewport?.removeEventListener("resize",fit);
      window.visualViewport?.removeEventListener("scroll",fit);
      observer?.disconnect();
    };
  },[constrain]);
  const content=Children.only(children);
  const dialog=<div style={{position:"fixed",inset:0,height:"100dvh",boxSizing:"border-box",padding:16,background:"rgba(0,0,0,0.5)",zIndex,display:"flex",alignItems:"center",justifyContent:"center"}}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={label} style={{background:"white",borderRadius:12,width:"100%",maxWidth,maxHeight:"calc(100dvh - 32px)",minHeight:0,boxSizing:"border-box",display:"flex",flexDirection:"column",overflow:"hidden",transform:`translate(${offset.x}px, ${offset.y}px)`}}>
      <button type="button" aria-label={`Move ${label}`} title="Drag to move. Arrow keys move; Home centers." style={{flexShrink:0,border:0,borderBottom:"1px solid #E2E8F0",background:"#F1F5F9",color:"#475569",padding:"9px 16px",textAlign:"left",font:"600 12px system-ui",cursor:"grab",touchAction:"none"}}
        onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,y:event.clientY,offset};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const start=drag.current;if(start)move({x:start.offset.x+event.clientX-start.x,y:start.offset.y+event.clientY-start.y});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
        onKeyDown={event=>{const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];if(event.key==="Home"){event.preventDefault();move({x:0,y:0});}else if(delta){event.preventDefault();move({x:offset.x+delta[0],y:offset.y+delta[1]});}}}>
        ⠿ {label}
      </button>
      <div style={{minHeight:0,overflowY:"auto",overscrollBehavior:"contain"}}>
        {cloneElement(content,{style:{...content.props.style,width:"100%",maxWidth:"none",maxHeight:"none",boxSizing:"border-box",overflowY:"visible",borderRadius:0}})}
      </div>
    </div>
  </div>;
  return typeof document!=="undefined"?createPortal(dialog,document.body):dialog;
}
