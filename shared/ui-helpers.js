function companyLogoURL(){return typeof COMPANY_LOGO_URL==='string'?COMPANY_LOGO_URL:'company-logo.png';}
// UI-only adapters. Business formulas and permission policy remain in LiftCore.
function calculatorRun() {
  var success=function(){}, failure=function(){};
  var runner={withSuccessHandler:function(fn){success=fn;return runner;},withFailureHandler:function(fn){failure=fn;return runner;}};
  ['calculateTravelTime','calculatePowerAndAVR','calculateMotorPower','calculateSpeedSlip','calculateEnergyBill','calculateSolarSizing'].forEach(function(action){
    runner[action]=function(token,input){Promise.resolve().then(function(){
      if(!SESSION||SESSION.token!==token||!AccessCore.apiCan(SESSION,action))throw new Error('You do not have permission to do this.');
      var result=LiftCore.calculate(action,input);
      if(typeof LAST_CALC!=='undefined')LAST_CALC={action:action,inputs:JSON.parse(JSON.stringify(input)),result:result};
      return result;
    }).then(success).catch(failure);};
  });return runner;
}
var COMPONENT_DETAIL_CACHE={},COMPONENT_DETAIL_PENDING={},COMPONENT_DETAIL_EPOCH=0;
function clearComponentDetails(){COMPONENT_DETAIL_CACHE={};COMPONENT_DETAIL_PENDING={};COMPONENT_DETAIL_EPOCH++;}
function seedComponentDetails(details){
  if(!SESSION||!details)return;
  Object.keys(details).forEach(function(row){COMPONENT_DETAIL_CACHE[row]={at:Date.now(),token:SESSION.token,value:details[row]};});
}
function loadComponentDetails(row){
  if(!SESSION||!LiftCore.can(SESSION.role,'getComponentDetails'))return Promise.reject(new Error('You do not have permission to do this.'));
  var token=SESSION.token,epoch=COMPONENT_DETAIL_EPOCH,cached=COMPONENT_DETAIL_CACHE[row],key=token+':'+row;
  if(cached&&cached.token===token&&Date.now()-cached.at<120000)return Promise.resolve(cached.value);
  if(COMPONENT_DETAIL_PENDING[key])return COMPONENT_DETAIL_PENDING[key];
  var pending=new Promise(function(resolve,reject){
    google.script.run.withSuccessHandler(function(value){
      if(!SESSION||SESSION.token!==token||epoch!==COMPONENT_DETAIL_EPOCH){reject(new Error('Selection changed. Please search again.'));return;}
      COMPONENT_DETAIL_CACHE[row]={at:Date.now(),token:token,value:value};resolve(value);
    }).withFailureHandler(reject).getComponentDetails(token,row);
  });COMPONENT_DETAIL_PENDING[key]=pending;
  pending.then(function(){if(COMPONENT_DETAIL_PENDING[key]===pending)delete COMPONENT_DETAIL_PENDING[key];},function(){if(COMPONENT_DETAIL_PENDING[key]===pending)delete COMPONENT_DETAIL_PENDING[key];});return pending;
}
