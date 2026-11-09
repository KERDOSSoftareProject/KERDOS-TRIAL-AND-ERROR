import {BrandCoin} from "./Brand.jsx";

export function Drachma({size = 44, label = "Working…", showLabel = true, style}) {
  return (
    <span role="status" aria-label={label} title={label} className="kerdos-drachma" style={style}>
      <span className="kerdos-drachma-turn" aria-hidden="true">
        <BrandCoin size={size} />
        <BrandCoin size={size} className="kerdos-drachma-back" reverse />
      </span>
      {showLabel && label && <span style={{fontSize:13,fontWeight:700,color:"#003584"}}>{label}</span>}
    </span>
  );
}
