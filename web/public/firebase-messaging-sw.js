/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBSjZCfzzwrrexgaqxz5b-lvvgcEhKpWiw',
  authDomain: 'stoic-fluin-io.firebaseapp.com',
  projectId: 'stoic-fluin-io',
  storageBucket: 'stoic-fluin-io.firebasestorage.app',
  messagingSenderId: '1092484326500',
  appId: '1:1092484326500:web:caef6ab7f5ee215c59ab71',
});

firebase.messaging();
