import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgxSseResource } from './ngx-sse-resource';

describe('NgxSseResource', () => {
  let component: NgxSseResource;
  let fixture: ComponentFixture<NgxSseResource>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NgxSseResource],
    }).compileComponents();

    fixture = TestBed.createComponent(NgxSseResource);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
