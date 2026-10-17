(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LiftCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function round2_(n){return Math.round(n*100)/100;}function round3_(n){return Math.round(n*1000)/1000;}function round4_(n){return Math.round(n*10000)/10000;}
/** Lift engineering calculators v4. Helpers ending in _ are private to Apps Script. */
function lcNum_(input, key, label, min, max, integer) {
  var raw = input && input[key];
  if (raw === '' || raw === null || raw === undefined) throw new Error('Enter ' + label + '.');
  var n = Number(raw);
  if (!isFinite(n) || n < min || (max !== null && n > max) || (integer && Math.floor(n) !== n)) {
    throw new Error(label + ': enter ' + (integer ? 'a whole number' : 'a number') + ' from ' + min + (max === null ? ' or greater' : ' to ' + max) + '.');
  }
  return n;
}
function lcPct_(input, key, label, allowZero) {
  return lcNum_(input, key, label, allowZero ? 0 : 0.01, 100, false) / 100;
}
function lcRound_(n, places) {
  if (!isFinite(n)) throw new Error('The result is outside the supported range. Check the inputs.');
  var scale = Math.pow(10, places);
  return Math.round(n * scale) / scale;
}
function lcCeil_(n, places) {
  if (!isFinite(n)) throw new Error('The result is outside the supported range. Check the inputs.');
  var scale = Math.pow(10, places);
  return Math.ceil(n * scale) / scale;
}
function lcMotion_(height, speed, acceleration) {
  var peak = Math.min(speed, Math.sqrt(height * acceleration));
  var accelDistance = peak * peak / (2 * acceleration);
  var cruiseDistance = Math.max(0, height - 2 * accelDistance);
  return { peak: peak, accelDistance: accelDistance, cruiseDistance: cruiseDistance,
    seconds: 2 * peak / acceleration + cruiseDistance / peak };
}

// RPM must be the motor shaft RPM, not gearbox output or sheave RPM.
function lcSpeed_(input) {
  var type = String(input.motorType);
  if (['Gearless', 'Geared'].indexOf(type) < 0) throw new Error('Select gearless or geared machine.');
  var D = lcNum_(input, 'diameter', 'traction sheave diameter (mm)', 1, 5000, false) / 1000;
  var rpm = lcNum_(input, 'ratedRpm', 'motor shaft RPM', 0, 20000, false);
  var roping = lcNum_(input, 'roping', 'roping ratio', 1, 4, true);
  if ([1, 2, 4].indexOf(roping) < 0) throw new Error('Select 1:1, 2:1 or 4:1 roping.');
  var gearRatio = 1, sync = null, slip = null, slipPercent = null, slipRpm = null;
  var warnings = [];
  if (type === 'Geared') {
    gearRatio = lcNum_(input, 'gearA', 'gear ratio numerator A', 0.01, 10000, false) /
      lcNum_(input, 'gearB', 'gear ratio denominator B', 0.01, 10000, false);
    if (gearRatio < 1) throw new Error('For a reduction gearbox, A / B must be at least 1.');
    var f = lcNum_(input, 'frequency', 'motor electrical frequency (Hz)', 0.01, 1000, false);
    var poles = lcNum_(input, 'poles', 'actual motor pole count', 2, 100, true);
    if (poles % 2 !== 0) throw new Error('Motor pole count must be even: 2, 4, 6, 8, etc. Enter poles, not pole pairs.');
    sync = 120 * f / poles;
    slipRpm = sync - rpm;
    var s = slipRpm / sync;
    slipPercent = s * 100;
    slip = s * f;
    if (s < 0) warnings.push('Negative slip: the shaft is above synchronous speed. This can occur in generating operation. For a motoring/nameplate check, verify frequency, RPM and poles.');
    if (s > 0.15) warnings.push('Slip exceeds 15%. Check that RPM and electrical frequency refer to the same operating point and that the pole count is correct.');
  }
  var sheaveRpm = rpm / gearRatio;
  return { motorType: type, gearRatio: type === 'Geared' ? lcRound_(gearRatio, 4) : null,
    sheaveRpm: lcRound_(sheaveRpm, 3), carSpeed: lcRound_(Math.PI * D * sheaveRpm / (60 * roping), 4),
    syncRpm: sync === null ? null : lcRound_(sync, 3),
    slipRpm: slipRpm === null ? null : lcRound_(slipRpm, 3),
    slipPercent: slipPercent === null ? null : lcRound_(slipPercent, 3),
    slipFrequency: slip === null ? null : lcRound_(slip, 4), warnings: warnings };
}

// Trip estimator: integrate F*v through acceleration, constant speed and deceleration.
// Includes counterweight balance, both travel directions and mechanical losses.
// This is an engineering estimate, not an ISO 25745 certification calculation.
function lcEnergy_(input) {
  var capacity = lcNum_(input, 'capacity', 'lift capacity (kg)', 1, 50000, false);
  var speed = lcNum_(input, 'speed', 'rated car speed (m/s)', 0.01, 20, false);
  var motor = lcNum_(input, 'motorPowerKW', 'rated motor output (kW)', 0.01, 1000, false);
  var height = lcNum_(input, 'tripDistance', 'average one-way travel distance (m)', 0.01, 1000, false);
  var trips = lcNum_(input, 'trips', 'one-way trips per operating day', 0, 50000, true);
  var car = lcNum_(input, 'carMass', 'empty car mass (kg)', 1, 100000, false);
  var balance = lcPct_(input, 'balance', 'counterweight balance (%)', true);
  var cw = car + balance * capacity;
  var upLoad = lcPct_(input, 'upLoad', 'average up-trip load (%)', true);
  var downLoad = lcPct_(input, 'downLoad', 'average down-trip load (%)', true);
  var upShare = lcPct_(input, 'upShare', 'upward trips (%)', true);
  var a = lcNum_(input, 'acceleration', 'acceleration/deceleration (m/s²)', 0.01, 3, false);
  var friction = lcNum_(input, 'frictionPercent', 'equivalent friction (% of moving weight)', 0, 20, false) / 100;
  var extraMass = lcNum_(input, 'extraMass', 'additional equivalent inertia (kg)', 0, 100000, false);
  var mechanicalEta = lcPct_(input, 'mechanicalEfficiency', 'transmission efficiency (%)', false);
  var motorEta = lcPct_(input, 'motorEfficiency', 'motor efficiency (%)', false);
  var driveEta = lcPct_(input, 'driveEfficiency', 'drive efficiency (%)', false);
  var regen = lcPct_(input, 'regenEfficiency', 'effective regeneration recovery (%)', true);
  var lightW = lcNum_(input, 'lightW', 'car light total watts', 0, 100000, false);
  var fanW = lcNum_(input, 'fanW', 'car fan total watts', 0, 100000, false);
  var lightH = lcNum_(input, 'lightHours', 'car light hours/day', 0, 24, false);
  var fanH = lcNum_(input, 'fanHours', 'car fan hours/day', 0, 24, false);
  var controlW = lcNum_(input, 'controlW', 'standing control/standby load (W)', 0, 100000, false);
  var brakeW = lcNum_(input, 'brakeW', 'brake coil total watts while moving', 0, 100000, false);
  var doorW = lcNum_(input, 'doorW', 'door drive watts', 0, 100000, false);
  var doorSeconds = lcNum_(input, 'doorSeconds', 'door operating seconds per trip', 0, 600, false);
  var monthDays = lcNum_(input, 'monthDays', 'calendar days in month', 1, 31, true);
  var monthActive = lcNum_(input, 'monthActiveDays', 'operating days in month', 0, monthDays, true);
  var yearDays = lcNum_(input, 'yearDays', 'calendar days in year', 365, 366, true);
  var yearActive = lcNum_(input, 'yearActiveDays', 'operating days in year', 0, yearDays, true);
  var motion = lcMotion_(height, speed, a);
  var movingHours = trips * motion.seconds / 3600;
  var doorHours = trips * doorSeconds / 3600;
  if (movingHours + doorHours > 24) throw new Error('Travel plus door operating time exceeds 24 hours/day. Check trips, distance and door time.');
  function trip(load, direction) {
    var payload = capacity * load;
    var movingMass = car + payload + cw;
    var inertia = movingMass + extraMass;
    var gravityForce = direction * (car + payload - cw) * 9.80665;
    var frictionForce = movingMass * 9.80665 * friction;
    var phases = [[a, motion.accelDistance], [0, motion.cruiseDistance], [-a, motion.accelDistance]];
    var consumed = 0, recovered = 0, peakShaft = 0;
    phases.forEach(function (phase) {
      var force = gravityForce + frictionForce + inertia * phase[0];
      var joules = force * phase[1];
      if (phase[1] === 0) return;
      if (joules > 0) consumed += joules / (mechanicalEta * motorEta * driveEta);
      else recovered += -joules * mechanicalEta * regen;
      peakShaft = Math.max(peakShaft, force * motion.peak / mechanicalEta / 1000);
    });
    return { consumed: consumed / 3600000, recovered: recovered / 3600000, peakShaft: peakShaft };
  }
  var up = trip(upLoad, 1), down = trip(downLoad, -1);
  var peakShaft = trips === 0 ? 0 : Math.max(upShare > 0 ? up.peakShaft : 0, upShare < 1 ? down.peakShaft : 0);
  var driveConsumed = trips * (upShare * up.consumed + (1 - upShare) * down.consumed);
  var recovered = trips * (upShare * up.recovered + (1 - upShare) * down.recovered);
  var brakeEnergy = brakeW * movingHours / 1000;
  var doorEnergy = doorW * doorHours / 1000;
  var standing = (lightW * lightH + fanW * fanH + controlW * 24) / 1000;
  var variableEnergy = driveConsumed + brakeEnergy + doorEnergy;
  // Import-energy estimate excludes export revenue. Negative daily energy is not a negative bill.
  var usedRecovery = Math.min(recovered, variableEnergy + standing);
  var daily = Math.max(0, variableEnergy + standing - usedRecovery);
  var monthly = monthActive * daily + (monthDays - monthActive) * standing;
  var annually = yearActive * daily + (yearDays - yearActive) * standing;
  var tariff = null;
  if (input.tariff !== '' && input.tariff !== null && input.tariff !== undefined) tariff = lcNum_(input, 'tariff', 'energy tariff per kWh', 0, 100000, false);
  var currency = String(input.currency || 'BDT').trim().slice(0, 12);
  var warnings = ['Estimate for the entered trip pattern. Calibrate friction, efficiencies and loads using the lift energy meter.'];
  if (peakShaft > motor) warnings.push('Estimated peak shaft demand ' + lcRound_(peakShaft, 2) + ' kW exceeds the entered motor rating. Check the lift data and motor overload capability; the model does not cap the energy to hide this mismatch.');
  if (motion.peak < speed) warnings.push('Average trip is too short to reach rated speed; a triangular speed profile is used.');
  if (regen > 0) warnings.push('Regeneration is an approximate daily energy credit. Actual billed imports depend on simultaneous loads and metering; no export payment is included.');
  if (tariff === null) warnings.push('Enter your actual electricity tariff to calculate the cost.');
  return { capacity: capacity, counterweightKg: lcRound_(cw, 2), tripSeconds: lcRound_(motion.seconds, 2),
    peakSpeed: lcRound_(motion.peak, 3), movingHours: lcRound_(movingHours, 3),
    tractionKWh: lcRound_(driveConsumed, 4), brakeKWh: lcRound_(brakeEnergy, 4), doorKWh: lcRound_(doorEnergy, 4),
    standingKWh: lcRound_(standing, 4), recoveredKWh: lcRound_(usedRecovery, 4),
    peakShaftKW: lcRound_(peakShaft, 3), dailyKWh: lcRound_(daily, 4), monthlyKWh: lcRound_(monthly, 4), annualKWh: lcRound_(annually, 4),
    dailyCost: tariff === null ? null : lcRound_(daily * tariff, 2),
    monthlyCost: tariff === null ? null : lcRound_(monthly * tariff, 2),
    annualCost: tariff === null ? null : lcRound_(annually * tariff, 2), currency: currency,
    monthActiveDays: monthActive, monthDays: monthDays, yearActiveDays: yearActive, yearDays: yearDays,
    motorPowerKW: motor, auxiliaryW: lightW + fanW + controlW + brakeW, warnings: warnings };
}


// Size an AC solar/battery supply feeding the existing elevator controller/drive.
// Candidate ratings are sourcing requirements, not validated manufacturer models.
function lcSolar_(input) {
  var motor = lcNum_(input, 'motorPowerKW', 'motor output (kW)', 0.01, 1000, false);
  var amps = lcNum_(input, 'motorCurrent', 'motor nameplate current (A)', 0.01, 10000, false);
  var voltage = lcNum_(input, 'voltage', 'three-phase AC line voltage (V)', 100, 1000, false);
  var motorEta = lcPct_(input, 'motorEfficiency', 'motor efficiency (%)', false);
  var driveEta = lcPct_(input, 'driveEfficiency', 'elevator drive efficiency (%)', false);
  var auxiliary = lcNum_(input, 'auxiliaryW', 'simultaneous lights, fan, controls and brake watts', 0, 100000, false) / 1000;
  var pf = lcPct_(input, 'inputPF', 'true power factor at elevator drive input (%)', false);
  var margin = lcNum_(input, 'margin', 'supply sizing margin (%)', 0, 100, false) / 100;
  var surge = lcNum_(input, 'surgePercent', 'short-duration motor demand (%)', 100, 400, false) / 100;
  var duration = lcNum_(input, 'surgeSeconds', 'required overload duration (seconds)', 1, 600, false);
  var dayEnergy = lcNum_(input, 'dailyKWh', 'daily AC energy (kWh)', 0, 100000, false);
  var coverage = lcPct_(input, 'solarCoverage', 'daily solar energy coverage (%)', true);
  var psh = lcNum_(input, 'sunHours', 'design peak sun hours/day', 0.1, 12, false);
  var yieldFactor = lcPct_(input, 'solarYield', 'PV-to-load yield factor (%)', false);
  var panelW = lcNum_(input, 'panelW', 'one panel rated watts', 1, 2000, false);
  var backupHours = lcNum_(input, 'backupHours', 'backup duration (hours)', 0.01, 168, false);
  var duty = lcPct_(input, 'backupDuty', 'motor running time during backup (%)', true);
  var inverterEta = lcPct_(input, 'inverterEfficiency', 'battery inverter efficiency (%)', false);
  var batteryEta = lcPct_(input, 'batteryEfficiency', 'battery discharge efficiency (%)', false);
  var dod = lcPct_(input, 'dod', 'usable battery depth of discharge (%)', false);
  var retained = lcPct_(input, 'retainedCapacity', 'battery end-of-life capacity (%)', false);
  var moduleV = lcNum_(input, 'moduleV', 'battery module nominal voltage (V)', 1, 1000, false);
  var minV = lcNum_(input, 'minimumV', 'minimum battery operating voltage (V)', 1, moduleV, false);
  var moduleAh = lcNum_(input, 'moduleAh', 'one battery module capacity (Ah)', 1, 100000, false);
  var moduleA = lcNum_(input, 'moduleCurrent', 'one battery module continuous discharge (A)', 0.01, 100000, false);
  var modulePeakA = lcNum_(input, 'modulePeakCurrent', 'one battery module peak discharge (A)', moduleA, 100000, false);
  var modulePeakSeconds = lcNum_(input, 'modulePeakSeconds', 'battery module peak rating duration (seconds)', 1, 3600, false);
  var parallelLimit = lcNum_(input, 'parallelLimit', 'manufacturer maximum parallel modules', 1, 1000, true);
  var motorInput = motor / (motorEta * driveEta);
  var running = motorInput + auxiliary;
  var peak = motorInput * surge + auxiliary;
  var minimumKW = running * (1 + margin);
  var minimumKVA = minimumKW / pf;
  var minimumPeakKW = peak * (1 + margin);
  var minimumPeakKVA = minimumPeakKW / pf;
  var acCurrent = minimumKVA * 1000 / (Math.sqrt(3) * voltage);
  var backupEnergy = (motorInput * duty + auxiliary) * backupHours;
  var nominalRequired = backupEnergy * (1 + margin) / (inverterEta * batteryEta * dod * retained);
  var moduleKWh = moduleV * moduleAh / 1000;
  var continuousDC = minimumKW * 1000 / (minV * inverterEta);
  var peakDC = minimumPeakKW * 1000 / (minV * inverterEta);
  var energyCount = Math.ceil(nominalRequired / moduleKWh);
  var continuousCount = Math.ceil(continuousDC / moduleA);
  var usablePeakA = duration <= modulePeakSeconds ? modulePeakA : moduleA;
  var peakCount = Math.ceil(peakDC / usablePeakA);
  var count = Math.max(1, energyCount, continuousCount, peakCount);
  var requiredPV = dayEnergy * coverage / (psh * yieldFactor);
  var panelCount = Math.ceil(requiredPV * 1000 / panelW);
  var installedPV = panelCount * panelW / 1000;
  var nominalBank = count * moduleKWh;
  var usableBankAC = nominalBank * inverterEta * batteryEta * dod * retained;
  var driveSizes = [1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 400, 500, 630, 800, 1000];
  var driveClass = driveSizes.filter(function (v) { return v >= motor; })[0];
  var warnings = ['Use an elevator-compatible three-phase solar/battery inverter supplying the existing elevator controller. A solar pump VFD is not an interchangeable elevator drive.',
    'Verify regenerative-energy handling, supply neutral/earthing, inverter transfer time, protections and controller compatibility with the equipment suppliers.',
    'Panel quantity is an energy estimate. Series/parallel strings require panel Voc/Vmp, temperature and inverter MPPT/DC limits.',
    'Battery modules below are parallel units at the stated module voltage. Never series-connect modules unless the manufacturer explicitly supports it.'];
  if (count > parallelLimit) warnings.push('This module configuration exceeds the manufacturer parallel limit (' + parallelLimit + '). Select higher-capacity/current modules or a compatible higher-voltage system; do not use the calculated bank as-is.');
  if (duration > modulePeakSeconds) warnings.push('The required overload lasts longer than the battery peak-current rating. The module count therefore uses its continuous current limit for the peak duty.');
  if (moduleV <= 60 && continuousDC > 150) warnings.push('High DC current at this battery voltage. Review a compatible higher-voltage storage system and battery/inverter current ratings.');
  if (duty === 0) warnings.push('Zero motor running time sizes backup energy for auxiliaries only. Power ratings still allow the motor to run.');
  return { driveClassKW: driveClass, driveCurrentA: lcCeil_(amps, 2), drivePeakCurrentA: lcCeil_(amps * surge, 2),
    voltage: voltage, overloadSeconds: duration, runningKW: lcRound_(running, 3),
    inverterKW: lcCeil_(minimumKW, 3), inverterKVA: lcCeil_(minimumKVA, 3), inverterCurrentA: lcCeil_(acCurrent, 2),
    inverterPeakKW: lcCeil_(minimumPeakKW, 3), inverterPeakKVA: lcCeil_(minimumPeakKVA, 3),
    backupEnergyKWh: lcRound_(backupEnergy, 3), requiredBatteryKWh: lcRound_(nominalRequired, 3),
    moduleCount: count, moduleVoltage: moduleV, bankAh: lcRound_(count * moduleAh, 2),
    bankKWh: lcRound_(nominalBank, 3), usableACKWh: lcRound_(usableBankAC, 3),
    dcCurrentA: lcCeil_(continuousDC, 2), dcPeakCurrentA: lcCeil_(peakDC, 2),
    configurationValid: count <= parallelLimit, energyModuleCount: energyCount,
    continuousModuleCount: continuousCount, peakModuleCount: peakCount,
    pvRequiredKWp: lcRound_(requiredPV, 3), panelCount: panelCount, panelW: panelW,
    installedPVKWp: lcRound_(installedPV, 3), pvDailyKWh: lcRound_(installedPV * psh * yieldFactor, 3),
    warnings: warnings };
}


function calculateTravelTime(input) {
  var H = Number(input.height), V = Number(input.speed), a = Number(input.accDec);
  if (!(H > 0) || !(V > 0) || !(a > 0)) {
    throw new Error('Travel Height, Rated Speed and Acc/Dec must all be positive numbers.');
  }
  var t1 = V / a;
  var d1 = 0.5 * a * t1 * t1;
  var totalAccDecTime = 2 * t1;
  var totalAccDecDist = 2 * d1;
  var d2 = H - totalAccDecDist;
  var warning = null, t2, totalTime;

  if (d2 < 0) {
    // Travel is too short to reach rated speed (triangular profile)
    var t1b = Math.sqrt(H / a);
    t1 = t1b; d1 = H / 2; totalAccDecDist = H; d2 = 0; t2 = 0;
    totalAccDecTime = 2 * t1b; totalTime = 2 * t1b;
    warning = 'For this travel height the lift cannot reach rated speed; a triangular speed profile was used.';
  } else {
    t2 = d2 / V;
    totalTime = totalAccDecTime + t2;
  }
  return {
    t1: round2_(t1), accelDistance: round2_(d1),
    totalAccDecTime: round2_(totalAccDecTime), totalAccDecDist: round2_(totalAccDecDist),
    remainingDistance: round2_(d2), timeAtRatedSpeed: round2_(t2),
    totalTime: round2_(totalTime), warning: warning
  };
}
function calculatePowerAndAVR(input) {
  function num(v, def) {
    if (v === '' || v === null || v === undefined) return def;
    var n = Number(v);
    if (isNaN(n) || n < 0) throw new Error('All values must be zero or positive numbers.');
    return n;
  }
  var motorPowerKW = Number(input.motorPowerKW);
  if (!(motorPowerKW > 0)) throw new Error('Motor Power (kW) must be a positive number.');
  var k2 = num(input.k2, 0.95), k3 = num(input.k3, 0.95);
  var brakePowerBothW = num(input.brakePowerBothW, 0);
  var tubeLightQty = num(input.tubeLightQty, 0), panelLightQty = num(input.panelLightQty, 0);
  var spotLightQty = num(input.spotLightQty, 0), crossFlowFanQty = num(input.crossFlowFanQty, 0);
  var othersFixedW = num(input.othersFixedW, 500);

  var drivePowerW = motorPowerKW * k2 * 1000;
  var brakePowerW = brakePowerBothW * k3;
  var shaftLightW = tubeLightQty * 10;
  var carLightW = panelLightQty * 24 + spotLightQty * 5;
  var carFanW = crossFlowFanQty * 25;
  var totalPowerKW = (drivePowerW + brakePowerW + shaftLightW + carLightW + carFanW + othersFixedW) / 1000;
  var suggestAVR = totalPowerKW * 2.5;
  var suggestGenerator = suggestAVR * 0.75;

  return {
    drivePowerW: round2_(drivePowerW), brakePowerW: round2_(brakePowerW),
    shaftLightW: round2_(shaftLightW), carLightW: round2_(carLightW),
    carFanW: round2_(carFanW), othersFixedW: round2_(othersFixedW),
    totalPowerKW: round4_(totalPowerKW),
    suggestAVRKVA: round3_(suggestAVR), suggestGeneratorKVA: round3_(suggestGenerator)
  };
}
function calculateMotorPower(input) {
  var rpm = Number(input.ratedRpm), torque = Number(input.torque);
  if (!(rpm > 0)) throw new Error('Rated RPM must be a positive number.');
  if (!(torque > 0)) throw new Error('Torque must be a positive number.');
  return { motorPowerKW: round2_(torque * rpm / 9550) };
}
var calculators={calculateSpeedSlip:lcSpeed_,calculateEnergyBill:lcEnergy_,calculateSolarSizing:lcSolar_,calculateTravelTime:calculateTravelTime,calculatePowerAndAVR:calculatePowerAndAVR,calculateMotorPower:calculateMotorPower};
var publicActions=['login','register','ping'];
var userActions=['getSession','refreshIndex','getComponentDetails','changePassword','logAction'];
var adminActions=['adminListUsers','adminUpdateUser','adminResetPassword','adminGetComponents','adminSaveComponent','adminDeleteComponent','adminStats'];
function roles(scope){return scope==='admin'?['Super Admin']:scope==='read'?['Super Admin','Admin','R&I']:['Super Admin','Admin','R&I','User'];}
function allowed(action){if(typeof AccessCore!=='undefined'&&AccessCore.apiAllowed(action))return true;if(typeof TroubleCore!=='undefined'&&TroubleCore.allowed(action))return true;return publicActions.concat(userActions,adminActions,Object.keys(calculators),['saveEngineeringRecord','listEngineeringRecords']).indexOf(action)>=0;}
function can(role,action,actor){if(typeof AccessCore!=='undefined'){if(!actor&&typeof SESSION!=='undefined'&&SESSION&&SESSION.role===role)actor=SESSION;return allowed(action)&&AccessCore.apiCan(actor||{role:role,status:'Approved',permissions:[]},action);}if(typeof TroubleCore!=='undefined'&&TroubleCore.allowed(action))return TroubleCore.can(role,action);if(!allowed(action))return false;if(publicActions.indexOf(action)>=0)return true;if(adminActions.indexOf(action)>=0)return role==='Admin';if(calculators[action]||action==='saveEngineeringRecord'||action==='listEngineeringRecords')return roles('calculate').indexOf(role)>=0;return ['Admin','Full','Selection'].indexOf(role)>=0;}
function calculate(action,input){if(!calculators[action])throw new Error('Unknown calculator.');return calculators[action](input);}
function record(data){if(!data||data.version!==1||!/^[-a-zA-Z0-9]{12,100}$/.test(String(data.id||'')))throw new Error('Invalid record ID/version.');if(!calculators[data.action])throw new Error('Invalid calculation record.');var result=calculate(data.action,data.inputs);var date=new Date(data.createdAt);if(isNaN(date.getTime()))throw new Error('Invalid record date.');return {version:1,id:String(data.id),action:data.action,inputs:data.inputs,result:result,note:String(data.note||'').slice(0,500),createdAt:date.toISOString()};}
function registration(name,email,password){name=String(name||'').trim().replace(/^[=+\-@\s]+/,'');email=String(email||'').trim().toLowerCase();password=String(password||'');if(!name)throw new Error('Please enter your name.');if(!/^[A-Za-z0-9][^\s@]*@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Please enter a valid email address.');if(password.length<8)throw new Error('Password must be at least 8 characters.');return {name:name,email:email,password:password};}
function scalar(v){var s=String(v===null||v===undefined?'':v).trim();if(s==='')return '';if(/^-?\d+(\.\d+)?$/.test(s))return Number(s);return /^[=+@]/.test(s)?"'"+s:s;}
function component(values,n){if(!Array.isArray(values)||values.length!==n)throw new Error('Component column count mismatch.');var clean=values.map(scalar);for(var i=0;i<4;i++)if(clean[i]==='')throw new Error('Capacity, speed, usage and roping are required.');if(!(Number(clean[0])>0)||!(Number(clean[1])>0))throw new Error('Capacity and speed must be positive.');return clean;}
function backendURL(url){return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(String(url||''));}
function csv(rows){return rows.map(function(row){return row.map(function(value){var s=String(value==null?'':value);if(typeof value!=='number'&&/^[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');}
return {categories:[
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
],version:1,registration:registration,allowed:allowed,can:can,roles:roles,calculate:calculate,record:record,scalar:scalar,component:component,backendURL:backendURL,csv:csv};
});
