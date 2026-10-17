var COMPONENT_CATEGORIES=[
  {
    title: '1. Selected Motor Data',
    fields: [
      ['Motor brand', 'Motor Brand'],
      ['Motor Model', 'Motor Model'],
      ['Motor Type', 'Motor Type'],
      ['Motor Power (KW)', 'Motor Power (kW)'],
      ['Motor Rated (A)', 'Motor Rated Current (A)'],
      ['Traction Sheave Dia (mm)', 'Traction Sheave Diameter (mm)'],
      ['Speed (m/s)', 'Speed (m/s)'],
      ['Rope Dia (mm)', 'Rope Diameter (mm)'],
      ['Rope Num', 'Rope Number'],
      ['Usage Type', 'Usage Type']
    ]
  },
  {
    title: '2. Recommended ARKEL Control System',
    fields: [
      ['Recommended ARKEL Controller KW', 'Controller Power (kW)'],
      ['Recommended ARKEL Controller Amp', 'Controller Current (A)'],
      ['Brake Resistor for ARKEL', 'Brake Resistor'],
      ['UPS for ARKEL', 'UPS']
    ]
  },
  {
    title: '3. Recommended NICE3000+ Control System',
    fields: [
      ['Recommended NICE3000+ Controller KW', 'Controller Power (kW)'],
      ['Recommended NICE3000+ Controller Amp', 'Controller Current (A)'],
      ['Brake Resistor for NICE3000+', 'Brake Resistor'],
      ['ARD For NICE3000+', 'ARD']
    ]
  },
  {
    title: '4. Power Supply Recommendation',
    fields: [
      ['Recommended AVR', 'Recommended AVR Rating'],
      ['Main Power Cable (RM)', 'Main Power Cable Size'],
      ['SDB main breaker', 'SDB Main Breaker Rating (A)']
    ]
  }
];
function componentSnapshot(data){var headers=data.headers;function val(v,n){return v[headers.indexOf(n)]??'';}var details={},index=data.records.map(function(r){var v=r.values;details[r.sheetRow]={inputs:{capacity:val(v,'Capacity (KG)'),speed:val(v,'Speed (m/s)'),usageType:val(v,'Usage Type'),roping:val(v,'Roping')},categories:COMPONENT_CATEGORIES.map(function(c){return {title:c.title,items:c.fields.map(function(f){return {label:f[1],value:String(val(v,f[0])||'-')};})};})};return {r:r.sheetRow,c:Number(val(v,'Capacity (KG)')),s:Number(val(v,'Speed (m/s)')),u:String(val(v,'Usage Type')),p:String(val(v,'Roping')),b:String(val(v,'Motor brand')),m:String(val(v,'Motor Model')),t:String(val(v,'Motor Type'))};});return {index:index,componentDetails:details,indexError:''};}
