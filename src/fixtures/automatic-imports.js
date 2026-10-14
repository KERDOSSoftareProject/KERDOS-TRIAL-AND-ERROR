// Synthetic fixtures with explicit expected outcomes. No customer documents.
export const categories=[
  {id:"meat",name:"Meat",keywords:["beef","chicken","bacon","turkey"]},
  {id:"dairy",name:"Dairy",keywords:["cheese","provolone"]},
  {id:"produce",name:"Produce",keywords:["grape","strawberry","spinach","chard"]},
  {id:"paper",name:"Paper Goods",keywords:["wrap","foil","paper"]},
  {id:"general",name:"General",keywords:["bread","base","jam"]},
];
export const automaticImports=[
  {name:"unit beside price",text:"Description\tPack\tPrice\nBeef\t10 LB\t$3.50/LB",ready:true},
  {name:"unit in price header",text:"Description\tPack\tPrice per LB\nBeef\t10 LB\t3.50",ready:true},
  {name:"unit in parenthesized header",text:"Description\tPack\tPrice (case)\nBeef\t10 LB\t35.00",ready:true},
  {name:"explicit document note",text:"All prices are per case\nDescription\tPack\tPrice\nBeef\t10 LB\t35.00",ready:true},
  {name:"explicit each",text:"Description\tPack\tPrice\nChicken\t4/10 LB\t25.00 ea",ready:true},
  {name:"explicit unit column",text:"Description\tPack\tPrice\tPrice UOM\nBeef\t10 LB\t3.50\tLB",ready:true},
  {name:"descriptor before measured pack",text:"Description\tPack\tPrice per LB\nProvolone\tSLICING12LB\t3.50",ready:true},
  {name:"prepared spread category",text:"Description\tPack\tPrice per case\nStrawberry jam\t200/.5 OZ\t24.00",ready:true,category:"general"},
  {name:"edible wrap category",text:"Description\tPack\tPrice per case\nSpinach wraps\t6/12 CT\t24.00",ready:true,category:"general"},
  {name:"source unit disagreement",text:"Description\tPack\tPrice\tQuoted per\nBeef\t10 LB\t$3.50/LB\tCASE",ready:false},
  {name:"unstated unit",text:"Description\tPack\tPrice\nBeef\t10 LB\t3.50",ready:false},
  {name:"incompatible dimensions",text:"Description\tPack\tPrice per LB\nBeef\t4/1 GAL\t3.50",ready:false},
  {name:"missing pack measurement",text:"Description\tPack\tPrice per LB\nTurkey\t2/9.5\t3.50",ready:false},
  {name:"unknown category",text:"Description\tPack\tPrice per case\nWidget xyz\t10 LB\t35.00",ready:false},
  {name:"contradictory document notes",text:"All prices are per case\nAll prices are per pound\nDescription\tPack\tPrice\nBeef\t10 LB\t3.50",ready:false},
  {name:"unreadable pack remainder",text:"Description\tPack\tPrice per case\nBeef\t10 LB + 2 OZ\t35.00",ready:false},
];
