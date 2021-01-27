import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'app-about-page',
  templateUrl: './about.component.html',
  styleUrls: ['./about.component.scss'],
})
export class AboutageComponent implements OnInit {
  public isMobile = window.innerWidth < 800
  constructor() {}

  ngOnInit() {}
}
