import {forwardRef,useImperativeHandle,useState} from 'react';
import {Drachma} from './Drachma.jsx';

// Child-owned state keeps progress updates from rerendering the entire table.
export const ImportSaveProgress=forwardRef(function ImportSaveProgress({total},ref){
  const [progress,setProgress]=useState({saved:0,failed:0});
  useImperativeHandle(ref,()=>({update:setProgress}),[]);
  const label=`Saved ${progress.saved} of ${total} rows${progress.failed?` · ${progress.failed} failed`:''}…`;
  return <Drachma label={label}/>;
});
