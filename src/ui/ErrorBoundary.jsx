import React from "react";

// A render error should be visible and recoverable instead of leaving a blank page.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state={failed:false};
  }

  static getDerivedStateFromError() {
    return {failed:true};
  }

  componentDidCatch(error,info) {
    console.error("KERDOS screen error",error,info);
  }

  render() {
    if(!this.state.failed) return this.props.children;
    return <main role="alert" style={{fontFamily:"system-ui,sans-serif",maxWidth:480,margin:"12vh auto",padding:24,color:"#19314A"}}>
      <h1 style={{fontSize:22}}>KERDOS could not display this screen</h1>
      <p>Reload the page to try again. If this keeps happening, contact the KERDOS administrator.</p>
      <button type="button" onClick={()=>window.location.reload()} style={{border:0,borderRadius:6,padding:"10px 16px",background:"#003584",color:"white",cursor:"pointer"}}>Reload KERDOS</button>
    </main>;
  }
}
