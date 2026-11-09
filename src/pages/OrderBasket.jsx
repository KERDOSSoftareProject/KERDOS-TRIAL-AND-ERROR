import {useEffect,useRef,useState} from 'react';

export const mobileOrderQuery='(max-width: 960px)';

export function useLayoutQuery(query){
  const [mobile,setMobile]=useState(()=>window.matchMedia?.(query).matches??false);
  useEffect(()=>{
    const media=window.matchMedia?.(query);
    if(!media)return;
    const sync=()=>setMobile(media.matches);
    media.addEventListener('change',sync);
    sync();
    return ()=>media.removeEventListener('change',sync);
  },[query]);
  return mobile;
}

export function OrderBasket({mobile,summary,children}){
  const dialog=useRef(null);
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
