import {useEffect,useRef,useState} from 'react';

export const mobileOrderQuery='(max-width: 960px)';

export function OrderBasket({summary,children}){
  const [mobile,setMobile]=useState(()=>window.matchMedia?.(mobileOrderQuery).matches??false);
  const dialog=useRef(null);
  useEffect(()=>{
    const media=window.matchMedia?.(mobileOrderQuery);
    if(!media)return;
    const sync=()=>setMobile(media.matches);
    media.addEventListener('change',sync);
    sync();
    return ()=>media.removeEventListener('change',sync);
  },[]);

  if(!mobile)return <aside className="order-aside">{children}</aside>;
  return <>
    <button type="button" className="mobile-basket-launch" aria-haspopup="dialog" onClick={()=>dialog.current.showModal()}>
      <span>View basket</span><span>{summary}</span>
    </button>
    <dialog ref={dialog} className="mobile-basket-dialog" aria-label="Order basket">
      <div className="mobile-basket-heading"><strong>Order basket</strong>
        <button type="button" onClick={()=>dialog.current.close()}>Close</button>
      </div>
      {children}
    </dialog>
  </>;
}
