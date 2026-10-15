const labels={CASE:'Case',EACH:'Each',EA:'Each',CT:'Count',DOZ:'Dozen',LB:'Pounds',OZ:'Ounces',KG:'Kilograms',G:'Grams',GAL:'Gallons',QT:'Quarts',PT:'Pints',FLOZ:'Fluid ounces',L:'Liters',ML:'Milliliters',FT:'Feet',IN:'Inches',YD:'Yards',M:'Meters',CM:'Centimeters',MM:'Millimeters'};
export function unitLabel(unit){return labels[String(unit||'').toUpperCase()]||String(unit||'');}
