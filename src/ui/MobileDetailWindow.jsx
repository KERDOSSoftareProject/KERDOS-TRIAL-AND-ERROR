import {useLayoutEffect,useRef} from 'react';
import {createPortal} from 'react-dom';

export function MobileDetailWindow({title,itemName,kind,open=true,inline=false,onMinimize,children}){
 const dialog=useRef(null);
 useLayoutEffect(()=>{
  if(!open||inline)return;
  const panel=dialog.current;
  const body=panel.ownerDocument.body;
  const {scrollX,scrollY}=window;
  panel.showModal();
  // A fixed page also holds its position when mobile Safari pans the viewport.
  body.style.setProperty('--mobile-detail-page-top',`${-scrollY}px`);
  body.classList.add('mobile-detail-page-locked');
  return ()=>{
   panel.close();
   body.classList.remove('mobile-detail-page-locked');
   body.style.removeProperty('--mobile-detail-page-top');
   window.scrollTo({left:scrollX,top:scrollY,behavior:'instant'});
  };
 },[open,inline]);
 if(inline)return children;
 return createPortal(<dialog ref={dialog} className={`mobile-detail-window mobile-detail-window--${kind}`} aria-label={`${title} for ${itemName}`}
   onClose={event=>{if(open&&!event.currentTarget.open)onMinimize();}}>
   <div className="mobile-detail-window-heading">
     <div><h3>{title}</h3><span>{itemName}</span></div>
     <button type="button" onClick={onMinimize}>Minimize</button>
   </div>
   <div className="mobile-detail-window-scroll">{children}</div>
 </dialog>,document.body);
}
